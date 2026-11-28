import { describe, expect, it } from "vitest";
import { proposalDiff } from "./proposalDiff";

const base = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: p
spec:
  inputs:
    type: object
  nodes:
    - id: write
      kind: process.exec
      config:
        executable: echo
        args: [fix]
    - id: report
      kind: process.exec
      dependsOn: [write]
      config:
        executable: echo
        args: [done]
`;

describe("proposalDiff", () => {
  it("is empty for identical text", () => {
    const d = proposalDiff(base, base)!;
    expect(d.count).toBe(0);
    expect(d.addedEdges).toEqual([]);
  });

  it("lists an added step and the connections it brings", () => {
    const next = base.replace(
      "    - id: report\n      kind: process.exec\n      dependsOn: [write]",
      "    - id: test\n      kind: process.exec\n      dependsOn: [write]\n      config:\n        executable: pnpm\n        args: [test]\n    - id: report\n      kind: process.exec\n      dependsOn: [test]",
    );
    const d = proposalDiff(base, next)!;
    expect(d.added.map((s) => s.id)).toEqual(["test"]);
    expect(d.edited.map((s) => s.id)).toEqual(["report"]);
    expect(d.edited[0].fields).toEqual([
      { field: "dependsOn", before: ["write"], after: ["test"] },
    ]);
    expect(d.addedEdges).toEqual(
      expect.arrayContaining([
        { from: "write", to: "test" },
        { from: "test", to: "report" },
      ]),
    );
    expect(d.removedEdges).toEqual([{ from: "write", to: "report" }]);
    expect(d.count).toBe(2);
  });

  it("lists an edited config field and a removed step", () => {
    const next = base
      .replace("args: [fix]", "args: [fix, --all]")
      .replace(
        "    - id: report\n      kind: process.exec\n      dependsOn: [write]\n      config:\n        executable: echo\n        args: [done]\n",
        "",
      );
    const d = proposalDiff(base, next)!;
    expect(d.edited).toEqual([
      expect.objectContaining({
        id: "write",
        fields: [{ field: "config.args", before: ["fix"], after: ["fix", "--all"] }],
      }),
    ]);
    expect(d.removed.map((s) => s.id)).toEqual(["report"]);
  });

  it("returns null when either text does not parse", () => {
    expect(proposalDiff(base, "spec: [")).toBeNull();
  });
});
