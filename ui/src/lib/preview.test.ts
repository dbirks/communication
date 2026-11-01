/**
 * `previewLine` — the one helper the three thread lists share for the row's
 * last-line preview (design 1b RECENT THREADS, 1g list). The pass-1 review:
 * a preview led with a literal `- ` (an agent's markdown bullet), and the
 * inline emphasis markers of `**done**` inked the row. The helper only ever
 * strips; it never adds.
 */
import { describe, expect, it } from "vitest";
import { previewLine } from "./preview";

describe("previewLine", () => {
  it("strips leading markdown block markers", () => {
    // The observed defect (threads list, pass 1).
    expect(previewLine("- hello.py: add a docstring to add()")).toBe(
      "hello.py: add a docstring to add()",
    );
    expect(previewLine("* landed the checkpoint")).toBe("landed the checkpoint");
    expect(previewLine("+ landed the checkpoint")).toBe("landed the checkpoint");
    expect(previewLine("## Implementation plan")).toBe("Implementation plan");
    expect(previewLine("###### deep heading")).toBe("deep heading");
    expect(previewLine("> quoted from the plan")).toBe("quoted from the plan");
    expect(previewLine("> > nested quote")).toBe("nested quote");
    expect(previewLine("1. add a docstring")).toBe("add a docstring");
    expect(previewLine("2) fix the assertion")).toBe("fix the assertion");
    // A marker stack strips to the sentence, and `#`/`##` never eat words:
    // a bare `#123` run number (no space after the marker) stays as written.
    expect(previewLine("- > **done**: all green")).toBe("done: all green");
    expect(previewLine("#123 landed")).toBe("#123 landed");
    expect(previewLine("2 + 2 = 4")).toBe("2 + 2 = 4");
  });

  it("strips paired inline emphasis markers but keeps intra-word underscores", () => {
    expect(previewLine("Landed **the checkpoint**; see `test_evidence`")).toBe(
      "Landed the checkpoint; see test_evidence",
    );
    expect(previewLine("*emphasis* and _stress_ and ~~gone~~")).toBe(
      "emphasis and stress and gone",
    );
    expect(previewLine("__bold__ run")).toBe("bold run");
    // Step ids and snake_case tokens keep their underscores.
    expect(previewLine("ran publish_verified and publish_needs_attention")).toBe(
      "ran publish_verified and publish_needs_attention",
    );
    // An unpaired marker is text — markdown itself renders it so.
    expect(previewLine("a * b and c * d")).toBe("a * b and c * d");
  });

  it("returns the empty string for nothing and for markup-only lines", () => {
    expect(previewLine(null)).toBe("");
    expect(previewLine(undefined)).toBe("");
    expect(previewLine("")).toBe("");
    expect(previewLine("   ")).toBe("");
    expect(previewLine("---")).toBe("---"); // a rule with no content stays as written
    expect(previewLine("- ")).toBe("");
    expect(previewLine("## ")).toBe("");
  });
});
