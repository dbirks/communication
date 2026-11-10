import { describe, expect, it } from "vitest";
import { DEFAULT_TRUST_LEVEL, TRUST_LEVELS, changeKindGlyph, trustPillLabel } from "./types";

describe("types (ADR-0050 mirror)", () => {
  it("lists exactly the three trust levels, with ask_risky first-class", () => {
    expect(TRUST_LEVELS.map((level) => level.value)).toEqual(["ask_all", "ask_risky", "no_ask"]);
    expect(DEFAULT_TRUST_LEVEL).toBe("ask_risky");
  });

  it("maps trust levels to the lowercase pill labels from the shots", () => {
    expect(trustPillLabel("ask_all")).toBe("ask every change");
    expect(trustPillLabel("ask_risky")).toBe("ask when risky");
    expect(trustPillLabel("no_ask")).toBe("don't ask");
  });

  it("says what each level does, and promises no undo anywhere (§4)", () => {
    expect(TRUST_LEVELS.map((level) => level.label)).toEqual([
      "Ask before every change",
      "Ask when it looks risky",
      "Don't ask",
    ]);
    expect(TRUST_LEVELS.map((level) => level.blurb)).toEqual([
      "You confirm every change.",
      "A decision model checks each call. Flagged ones wait for you.",
      "Everything runs. Each action is listed in the thread.",
    ]);
    for (const level of TRUST_LEVELS) {
      expect(`${level.label} ${level.blurb}`.toLowerCase()).not.toContain("undon");
    }
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
