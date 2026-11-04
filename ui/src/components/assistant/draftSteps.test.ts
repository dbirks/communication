import { describe, expect, it } from "vitest";
import {
  draftNameOf,
  draftLinkOf,
  draftRouteOf,
  draftStepRows,
  humanRouteLabel,
  isDraftLink,
  openDraftIdOf,
  readableLinkLabel,
  OPEN_DRAFT_LINK_LABEL,
} from "./draftSteps";

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

  /**
   * rcn-review13-2f: recognition is by the TARGET, not by the label's
   * wording. A draft route with any label — or no label at all — is the
   * saved draft; the label that lost the round-13 state was the raw path.
   */
  it("recognises the draft by its target, whatever the label says", () => {
    expect(
      openDraftIdOf([{ label: "Feature Delivery", route: "/workflows/pl-1/drafts/d-9" }]),
    ).toBe("d-9");
    expect(
      openDraftIdOf([{ label: "/workflows/pl-1/drafts/d-9", route: "/workflows/pl-1/drafts/d-9" }]),
    ).toBe("d-9");
    expect(openDraftIdOf([{ label: "", route: "/workflows/pl-1/drafts/d-9" }])).toBe("d-9");
    // the legacy /library alias still redirects to the draft page
    expect(openDraftIdOf([{ label: "draft", route: "/library/pl-1/drafts/d-9" }])).toBe("d-9");
  });

  it("returns null for no links, other targets, or a draft link without a draft id in the route", () => {
    expect(openDraftIdOf([])).toBeNull();
    expect(openDraftIdOf([{ label: "Open pipeline 01PL…", route: "/workflows/pl-9" }])).toBeNull();
    // the round-12 wording: the bare workflow page labelled `Open draft`
    // still counts as the draft door, but its route names no draft to read
    expect(openDraftIdOf([{ label: OPEN_DRAFT_LINK_LABEL, route: "/workflows/pl-9" }])).toBeNull();
  });
});

describe("isDraftLink / draftLinkOf / draftRouteOf", () => {
  it("a draft route is the draft regardless of its label (rcn-review13-2f)", () => {
    const route = "/workflows/pl-1/drafts/d-9";
    expect(isDraftLink({ label: "Open draft", route })).toBe(true);
    expect(isDraftLink({ label: "See the draft", route })).toBe(true);
    expect(isDraftLink({ label: route, route })).toBe(true);
    expect(isDraftLink({ label: "", route })).toBe(true);
    expect(draftRouteOf(route)).toBe("d-9");
    expect(draftRouteOf("/workflows/pl-9")).toBeNull();
  });

  it("a non-draft route is not the draft, whatever its label", () => {
    expect(isDraftLink({ label: "Open draft PR", route: "/runs/r-1" })).toBe(false);
    expect(isDraftLink({ label: "Go to 01PL…", route: "/workflows/pl-9" })).toBe(false);
  });

  it("the round-12 wording (bare workflow page labelled `Open draft`) still counts as the draft", () => {
    expect(isDraftLink({ label: "Open draft", route: "/workflows/pl-9" })).toBe(true);
    expect(
      draftLinkOf([
        { label: "Gate on run 01RR…", route: "/runs/r-1" },
        { label: "Open draft", route: "/workflows/pl-9" },
      ]),
    ).toEqual({ label: "Open draft", route: "/workflows/pl-9" });
    expect(draftLinkOf([])).toBeNull();
    expect(draftLinkOf([{ label: "Inbox", route: "/inbox" }])).toBeNull();
  });
});

describe("readableLinkLabel / humanRouteLabel (rcn-review13-2f: no raw-path chips)", () => {
  it("keeps the server's words when the label is not a path", () => {
    expect(readableLinkLabel({ label: "Open inbox", route: "/inbox" })).toBe("Open inbox");
    expect(readableLinkLabel({ label: "Run 01RR… · running", route: "/runs/r-1" })).toBe(
      "Run 01RR… · running",
    );
  });

  it("never prints a raw path: an empty or path label gets a humanised route", () => {
    expect(readableLinkLabel({ label: "", route: "/inbox" })).toBe("Inbox");
    expect(readableLinkLabel({ label: "/inbox", route: "/inbox" })).toBe("Inbox");
    expect(readableLinkLabel({ label: "/workflows/pl-9", route: "/workflows/pl-9" })).toBe(
      "Workflow pl-9",
    );
  });

  it("a draft target reads as `Open draft`, not the path", () => {
    expect(
      readableLinkLabel({
        label: "/workflows/pl-9/drafts/d-9",
        route: "/workflows/pl-9/drafts/d-9",
      }),
    ).toBe("Open draft");
    expect(humanRouteLabel("/library/pl-9/drafts/d-9")).toBe("Open draft");
  });

  it("humanises the common app routes with a short id", () => {
    expect(humanRouteLabel("/")).toBe("Home");
    expect(humanRouteLabel("/board")).toBe("Board");
    expect(humanRouteLabel("/threads/01TABCDEF")).toBe("Thread 01TABCDE…");
    expect(humanRouteLabel("/p/prj-1/runs")).toBe("Project prj-1");
    expect(humanRouteLabel("/runs/r-1")).toBe("Run r-1");
    expect(humanRouteLabel("/steps/s-1")).toBe("Step s-1");
    expect(humanRouteLabel("/approvals/a-1")).toBe("Approval a-1");
    expect(humanRouteLabel("/settings/layout")).toBe("Settings · Layout");
    // an unknown shape still reads as a word, never as a path
    expect(humanRouteLabel("/some-page")).toBe("Some page");
    expect(humanRouteLabel("/unknown/x/y")).toBe("Unknown");
  });
});

describe("draftNameOf", () => {
  it("reads metadata.name off the draft document for the chip's `Open draft · <name>`", () => {
    expect(draftNameOf(DOCUMENT_YAML)).toBe("emu-rcn-reply");
  });

  it("returns null for unreadable YAML, a missing name and an empty one", () => {
    expect(draftNameOf("metadata: { name:")).toBeNull();
    expect(draftNameOf("apiVersion: v1\nkind: Other\n")).toBeNull();
    expect(draftNameOf("metadata:\n  name: '  '\n")).toBeNull();
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
