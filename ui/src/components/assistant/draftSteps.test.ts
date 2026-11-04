import { describe, expect, it } from "vitest";
import { draftStepRows, openDraftIdOf, OPEN_DRAFT_LINK_LABEL } from "./draftSteps";

const DOCUMENT_YAML = `
apiVersion: communication.dev/v1alpha1
kind: PipelineDefinition
metadata:
  name: emu-rcn-reply
spec:
  nodes:
    - id: draft_reply
      kind: agent.acp
      config:
        profile: m4-planner
    - id: gate
      kind: human.approval
      dependsOn: [draft_reply]
      config:
        summary: "Approve the reply"
        approverRoles: [maintainer]
    - id: publish
      kind: agent.acp
      dependsOn: [gate]
      config:
        profile: m4-implementer
`;

describe("openDraftIdOf", () => {
  it("reads the draft id off the Open draft link's route", () => {
    expect(
      openDraftIdOf([{ label: OPEN_DRAFT_LINK_LABEL, route: "/workflows/pl-1/drafts/d-9" }]),
    ).toBe("d-9");
  });

  it("returns null for no links, other labels, or a route without a draft id", () => {
    expect(openDraftIdOf([])).toBeNull();
    expect(
      openDraftIdOf([{ label: "Feature Delivery", route: "/workflows/pl-1/drafts/d-9" }]),
    ).toBeNull();
    expect(openDraftIdOf([{ label: OPEN_DRAFT_LINK_LABEL, route: "/workflows/pl-9" }])).toBeNull();
  });
});

describe("draftStepRows", () => {
  it("lists the top-level nodes in document order with their profile (2f)", () => {
    const rows = draftStepRows(DOCUMENT_YAML, null);
    expect(rows).toEqual([
      { name: "draft_reply", profile: "m4-planner", state: "done" },
      { name: "gate", profile: "gate", state: "done" },
      { name: "publish", profile: "m4-implementer", state: "done" },
    ]);
  });

  it("marks the bound node current and every other node later — never done — while a question is open (2f)", () => {
    const rows = draftStepRows(DOCUMENT_YAML, {
      prompt: "The draft currently uses one step; the fork is which profile runs it.",
      options: [
        { label: "m4-planner", value: "planner" },
        { label: "m4-implementer", value: "implementer" },
      ],
    });
    expect(rows).not.toBeNull();
    const states = rows!.map((row) => row.state);
    expect(states).not.toContain("done");
    // the first node the question's options bind is the one marked ●
    expect(states).toEqual(["current", "later", "later"]);
  });

  it("marks the bound node by its id too, and keeps later nodes at ·", () => {
    const rows = draftStepRows(DOCUMENT_YAML, {
      prompt: "Should `publish` stay with m4-implementer or move?",
      options: [
        { label: "Keep it", value: "keep" },
        { label: "Move it", value: "move" },
      ],
    });
    expect(rows?.map((row) => [row.name, row.state])).toEqual([
      ["draft_reply", "later"],
      ["gate", "later"],
      ["publish", "current"],
    ]);
  });

  it("marks every node later when the question binds no node", () => {
    const rows = draftStepRows(DOCUMENT_YAML, {
      prompt: "Which channel should this go to first?",
      options: [
        { label: "stable", value: "stable" },
        { label: "beta", value: "beta" },
      ],
    });
    expect(rows?.every((row) => row.state === "later")).toBe(true);
  });

  it("returns null for unreadable YAML, a missing nodes list and an empty one", () => {
    expect(draftStepRows("spec: { nodes: [ { id: ", null)).toBeNull();
    expect(draftStepRows("apiVersion: v1\nkind: Other\n", null)).toBeNull();
    expect(draftStepRows("spec:\n  nodes: []\n", null)).toBeNull();
  });
});
