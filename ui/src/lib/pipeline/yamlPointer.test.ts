/**
 * The YAML viewer's contract with a validation finding: a marker on the line
 * the pointer names, or the words that say it could not be that precise.
 */
import { describe, expect, it } from "vitest";
import { indexPointers, resolvePointer, shortDigest } from "./yamlPointer";
import { samplePipelineYaml } from "../../test/fixtures/m4/samplePipeline";

describe("resolvePointer", () => {
  it("finds a block key on its own line", () => {
    // Line 31 of the sample is `- id: plan`: the sequence item and its first
    // key share a line, and the reader must see the marker on that line.
    expect(resolvePointer(samplePipelineYaml, "/spec/nodes/0/id")).toEqual({
      line: 31,
      exact: true,
      resolved: "/spec/nodes/0/id",
    });
    expect(samplePipelineYaml.split("\n")[30]).toBe("  - id: plan");
  });

  it("finds a key inside a sequence item, which sits at the dash's indent + 2", () => {
    // `/spec/nodes/2` is build_until_verified; its passWhen is 4 levels deep.
    expect(resolvePointer(samplePipelineYaml, "/spec/nodes/2/config/passWhen")?.exact).toBe(true);
    const line = resolvePointer(samplePipelineYaml, "/spec/nodes/2/config/passWhen")!.line;
    expect(samplePipelineYaml.split("\n")[line - 1]).toMatch(/^\s*passWhen:/);
  });

  it("walks into a nested body sequence", () => {
    const found = resolvePointer(
      samplePipelineYaml,
      "/spec/nodes/2/config/body/nodes/1/config/cwd",
    );
    expect(found?.exact).toBe(true);
    expect(samplePipelineYaml.split("\n")[found!.line - 1].trim()).toBe("cwd: repos/app");
  });

  it("lands a flow-value pointer on the enclosing line and admits it is not exact", () => {
    // `goal: {type: string, minLength: 1}` — the pointer below `goal` is real,
    // but the line can only be the one carrying the flow mapping.
    const found = resolvePointer(samplePipelineYaml, "/spec/inputs/properties/goal/minLength");
    expect(found).not.toBeNull();
    expect(found!.exact).toBe(false);
    expect(samplePipelineYaml.split("\n")[found!.line - 1]).toContain("goal: {type: string");
  });

  it("never mistakes block-scalar content for structure", () => {
    // The planner prompt contains `Acceptance criteria: …` — a mapping-lookalike
    // inside a `|` scalar must not become a pointer.
    expect(
      indexPointers(samplePipelineYaml).has("/spec/nodes/0/config/prompt/Acceptance criteria"),
    ).toBe(false);
  });

  it("falls back to the closest recorded ancestor, and says it did", () => {
    // A pointer at a node index the document does not have cannot be marked
    // precisely; the `nodes:` line is the furthest the reader can be taken, and
    // `exact: false` is what makes the component add the words "closest".
    const found = resolvePointer(samplePipelineYaml, "/spec/nodes/99/config/nope")!;
    expect(found.exact).toBe(false);
    expect(samplePipelineYaml.split("\n")[found.line - 1].trim()).toBe("nodes:");
  });

  it("returns nothing when even the first segment is unknown", () => {
    expect(resolvePointer(samplePipelineYaml, "/nothing/here")).toBeNull();
    expect(resolvePointer(samplePipelineYaml, "not a pointer")).toBeNull();
    expect(resolvePointer(samplePipelineYaml, null)).toBeNull();
  });

  it("reads a document whose keys are quoted", () => {
    const yaml = "spec:\n  nodes:\n  - 'id': plan\n    kind: agent.acp\n";
    expect(resolvePointer(yaml, "/spec/nodes/0/id")?.exact).toBe(true);
    expect(resolvePointer(yaml, "/spec/nodes/0/kind")?.exact).toBe(true);
  });
});

describe("shortDigest", () => {
  it("drops the algorithm prefix and keeps it readable", () => {
    expect(shortDigest("sha256:3f2f6e6a7ad1b1d8")).toBe("3f2f6e6a7ad1");
    expect(shortDigest(null)).toBe("—");
  });
});
