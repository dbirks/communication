/**
 * `New workflow` START FROM subtitles (design 1c). A template tile advertises
 * the document's own step chain; the Blank tile advertises what the starter
 * is — “One agent step”, derived honestly from the skeleton's parse — not
 * the placeholder node id `first` the author is meant to rename (the
 * side-by-side against the design render caught the raw id on the tile).
 */
import { describe, expect, it } from "vitest";
import { tileSubtitle } from "./NewWorkflowDialog";
import {
  BLANK_SKELETON_YAML,
  PIPELINE_TEMPLATES,
  templateById,
} from "../../lib/pipeline/templates";

describe("NewWorkflowDialog tileSubtitle", () => {
  it("the Blank tile says what it is — one step, not the skeleton's node id", () => {
    const blank = templateById("blank");
    expect(blank).toBeTruthy();
    expect(blank?.stepCount).toBe(1);
    expect(tileSubtitle(blank!)).toBe("One agent step");
    expect(tileSubtitle(blank!)).not.toContain("first");
  });

  it("template tiles keep the real step chain of their own document", () => {
    expect(tileSubtitle(templateById("plan-with-approval")!)).toBe(
      "survey › plan › approve › publish_plan",
    );
    expect(tileSubtitle(templateById("security-review")!)).toBe(
      "scan › summarize › publish_report",
    );
    expect(tileSubtitle(templateById("issue-to-pr")!)).toContain("implement");
    for (const template of PIPELINE_TEMPLATES.filter((t) => t.id !== "blank")) {
      expect(tileSubtitle(template)).not.toBe("One agent step");
    }
  });

  it("a step count other than one is still named honestly", () => {
    // Same rule the Blank tile rides: the count comes from parsing the
    // document, so a multi-node skeleton would read as its real size and an
    // unparseable one shows nothing rather than an invention.
    expect(
      tileSubtitle({
        ...templateById("blank")!,
        documentYaml: BLANK_SKELETON_YAML,
        stepCount: 3,
      }),
    ).toBe("3 steps");
    expect(
      tileSubtitle({
        ...templateById("blank")!,
        documentYaml: "not: [a: pipeline",
        stepCount: null,
      }),
    ).toBe("");
  });
});
