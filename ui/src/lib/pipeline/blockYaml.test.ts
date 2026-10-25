import { describe, expect, it } from "vitest";
import { isBlockStyle, toBlockYaml } from "./blockYaml";

/** The design 2d "today" snippet: flow style spec. */
const TODAY = `spec:
  inputs:
    type: object
    required: [goal, repository]
    properties:
      goal: {type: string, minLength: 1}
      repository: {type: string, minLength: 1}
  policies: {maxConcurrentNodes: 1, workspaceMode: worktree}
  nodes:
  - id: survey
    kind: process.exec
    retry: {maxAttempts: 2, backoff: {baseSeconds: 5}}
    config:
      workspace: {mode: read_only}
      outputExtraction: {mode: none}`;

describe("toBlockYaml", () => {
  it("converts the design 2d flow snippet to the proposed block lines", () => {
    expect(toBlockYaml(TODAY)).toEqual(`spec:
  inputs:
    type: object
    required:
      - goal
      - repository
    properties:
      goal:
        type: string
        minLength: 1
      repository:
        type: string
        minLength: 1
  policies:
    maxConcurrentNodes: 1
    workspaceMode: worktree
  nodes:
    - id: survey
      kind: process.exec
      retry:
        maxAttempts: 2
        backoff:
          baseSeconds: 5
      config:
        workspace:
          mode: read_only
        outputExtraction:
          mode: none
`);
  });

  it("keeps comments and key order", () => {
    const text = `# keep me
spec:
  inputs:
    required: [goal, repository]
nodes:
  - id: survey
    kind: process.exec
`;
    const out = toBlockYaml(text);
    expect(out.startsWith("# keep me")).toBe(true);
    expect(out).toContain("required:");
    expect(out).toContain("- goal");
    expect(out).toContain("kind: process.exec");
  });

  it("keeps `{}` for an empty map and `[]` for an empty sequence", () => {
    expect(toBlockYaml("spec:\n  inputs: {}\n")).toContain("inputs: {}");
    expect(toBlockYaml("spec:\n  nodes: []\n")).toContain("nodes: []");
  });

  it("returns the input unchanged on a parse error", () => {
    expect(toBlockYaml("spec: [\n")).toBe("spec: [\n");
  });

  // Design 2d polish: `lineWidth: 0` unfolded every `>-` description into one
  // very long line; block emission keeps the design's ~100-column measure.
  it("folds a long `>-` description instead of one very long line", () => {
    const sentence =
      "Survey a repository checkout, draft an implementation plan for a goal " +
      "with a chat model, hold it behind a maintainer approval, and publish the approved-shape plan.";
    const out = toBlockYaml(`metadata:
  description: >-
    ${sentence}
`);
    const longest = Math.max(...out.split("\n").map((line) => line.length));
    // One long line becomes several: the fold keeps every line near the
    // 100-column measure (a leading-word overrun of one word is the emitter's,
    // not an unfolded 160-character line).
    expect(out.split("\n").length).toBeGreaterThan(2);
    expect(longest).toBeLessThanOrEqual(120);
    // The value is unchanged — folding only rewraps the text.
    expect(out.replace(/\s+/g, " ")).toContain(
      "hold it behind a maintainer approval, and publish the approved-shape plan.",
    );
  });

  it("folds a long quoted scalar too", () => {
    const value = "word ".repeat(40).trim();
    const out = toBlockYaml(`description: "${value}"\n`);
    expect(out.split("\n").length).toBeGreaterThan(1);
    const longest = Math.max(...out.split("\n").map((line) => line.length));
    expect(longest).toBeLessThanOrEqual(120);
  });

  it("round-trips to an equal parsed document", async () => {
    const { parseDocument } = await import("yaml");
    const text = `spec:
  inputs:
    required:
      - goal
      - repository
    properties:
      goal:
        type: string
        minLength: 1
  nodes:
  - id: survey
    kind: process.exec
`;
    const before = parseDocument(text).toJS();
    const after = parseDocument(toBlockYaml(text)).toJS();
    expect(after).toEqual(before);
  });
});

describe("isBlockStyle", () => {
  it("is false for flow style", () => {
    expect(isBlockStyle(TODAY)).toBe(false);
  });

  it("is true for block style", () => {
    expect(isBlockStyle(toBlockYaml(TODAY))).toBe(true);
  });

  it("is false for empty flow collections", () => {
    expect(isBlockStyle("spec:\n  inputs: {}\n")).toBe(false);
  });
});
