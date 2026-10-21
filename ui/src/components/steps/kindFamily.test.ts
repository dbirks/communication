/**
 * The Steps page's kind families, config summaries and the semver patch
 * bump (design 3b): mapping correctness per catalogue kind, summaries that
 * never invent values, and a bump that refuses non-semantic labels.
 */
import { describe, expect, it } from "vitest";
import { bumpSemver, configSummary, familyOf, FAMILY_ORDER } from "./kindFamily";

describe("familyOf", () => {
  it("groups the artboard's five families", () => {
    expect(familyOf("agent.acp")).toBe("AGENT");
    expect(familyOf("model.chat")).toBe("AGENT");
    expect(familyOf("process.exec")).toBe("CHECK");
    expect(familyOf("condition")).toBe("CHECK");
    expect(familyOf("human.approval")).toBe("GATE");
    expect(familyOf("until")).toBe("LOOP");
    expect(familyOf("for_each")).toBe("LOOP");
    expect(familyOf("pipeline.invoke")).toBe("WORKFLOW");
  });

  it("keeps the publish kinds out of the other groups and orders OTHER last", () => {
    expect(familyOf("git.publish")).toBe("PUBLISH");
    expect(familyOf("artifact.publish")).toBe("PUBLISH");
    expect(familyOf("integration.query")).toBe("OTHER");
    expect(FAMILY_ORDER[FAMILY_ORDER.length - 1]).toBe("OTHER");
  });
});

describe("configSummary", () => {
  it("summarizes each kind from the config alone", () => {
    expect(configSummary("agent.acp", { profile: "reviewer", workspace_mode: "read_only" })).toBe(
      "reviewer · read_only",
    );
    expect(configSummary("agent.acp", { prompt: "hello" })).toBe(null);
    expect(configSummary("model.chat", { model: "claude" })).toBe("model claude");
    expect(configSummary("process.exec", { executable: "go", args: ["test", "./..."] })).toBe(
      "go test ./...",
    );
    expect(configSummary("condition", { cases: [{ when: "true", route: "yes" }] })).toBe("1 cases");
    expect(configSummary("human.approval", { timeout: "24h" })).toBe("timeout 24h");
    expect(configSummary("until", { maxIterations: 4 })).toBe("max 4");
    expect(configSummary("pipeline.invoke", { pipeline: "feature-delivery@1" })).toBe(
      "feature-delivery@1",
    );
  });

  it("never invents a summary for an empty or unknown config", () => {
    expect(configSummary("agent.acp", {})).toBe(null);
    expect(configSummary("process.exec", {})).toBe(null);
    expect(configSummary("mystery.kind", { note: "hi" })).toBe("note hi");
    expect(configSummary("mystery.kind", { note: 3 })).toBe(null);
  });
});

describe("bumpSemver", () => {
  it("patch-bumps semantic labels", () => {
    expect(bumpSemver("1.0.0")).toBe("1.0.1");
    expect(bumpSemver("2.0.0")).toBe("2.0.1");
    expect(bumpSemver(" 1.2.9 ")).toBe("1.2.10");
  });

  it("refuses non-semantic labels (the caller keeps the label unchanged)", () => {
    expect(bumpSemver("draft")).toBe(null);
    expect(bumpSemver("1.0")).toBe(null);
    expect(bumpSemver("")).toBe(null);
  });
});
