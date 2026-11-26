/**
 * The ADR-0086 rules that are not a screen: which profile the agent chip starts
 * on, and which profile a step the editor just added starts on.
 */
import { describe, expect, it } from "vitest";
import {
  pickDefaultAgent,
  stepNamesProfile,
  storedAgentChoice,
  withProjectDefaultAgent,
} from "./defaultAgent";
import { addNode } from "./pipeline/graphDoc";
import type { AgentProfile } from "../api/types";

function profile(id: string): AgentProfile {
  return {
    id,
    name: id,
    launcher_id: "claude",
    permission_mode: "ask",
    created_at: "2026-11-20T10:00:00Z",
    version: 1,
  };
}

const claude = profile("p-claude");
const codex = profile("p-codex");

describe("pickDefaultAgent", () => {
  it("the stored choice wins while the profile is still offered", () => {
    expect(
      pickDefaultAgent({ stored: codex.id, projectDefault: claude.id, profiles: [claude, codex] }),
    ).toBe(codex.id);
  });

  it("with no stored choice the project's default is used", () => {
    expect(
      pickDefaultAgent({ stored: null, projectDefault: codex.id, profiles: [claude, codex] }),
    ).toBe(codex.id);
  });

  it("a default that is no longer in the list is ignored, not shown", () => {
    expect(
      pickDefaultAgent({ stored: null, projectDefault: "gone", profiles: [claude, codex] }),
    ).toBe(claude.id);
  });

  it("a stored choice for a deleted profile is ignored too", () => {
    expect(
      pickDefaultAgent({ stored: "gone", projectDefault: codex.id, profiles: [claude, codex] }),
    ).toBe(codex.id);
  });

  it("with neither, the first profile", () => {
    expect(
      pickDefaultAgent({ stored: null, projectDefault: null, profiles: [claude, codex] }),
    ).toBe(claude.id);
  });

  it("no profiles at all is no pick, never an invented one", () => {
    expect(pickDefaultAgent({ stored: "x", projectDefault: "y", profiles: [] })).toBeNull();
  });

  it("storage that is unavailable reads as 'never chosen here'", () => {
    // jsdom has localStorage; the helper's job is only to never throw.
    expect(storedAgentChoice("")).toBeNull();
    expect(storedAgentChoice("absent-project")).toBeNull();
  });
});

const DOC = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: flow
spec:
  nodes:
    - id: plan
      kind: agent.acp
      config:
        profile: reviewer
        prompt: Read it
`;

describe("withProjectDefaultAgent", () => {
  it("a new agent step in a project scope starts on the project's default", () => {
    const added = addNode(DOC, { kind: "agent.acp", scope: [], after: "plan" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const withAgent = withProjectDefaultAgent(added, "agent.acp", codex.id);
    expect(withAgent.ok).toBe(true);
    if (!withAgent.ok) return;
    // The added step — the op's own `changed`, unchanged by the write.
    expect(withAgent.changed).toEqual(added.changed);
    expect(withAgent.text).toContain(`profile: ${codex.id}`);
    // And the step that was already there kept what it named.
    expect(withAgent.text).toContain("profile: reviewer");
  });

  it("with no project default the step is left exactly as the skeleton wrote it", () => {
    const added = addNode(DOC, { kind: "agent.acp", scope: [], after: "plan" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(withProjectDefaultAgent(added, "agent.acp", null)).toBe(added);
  });

  it("a step of another kind is never given an agent", () => {
    const added = addNode(DOC, { kind: "process.exec", scope: [], after: "plan" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(withProjectDefaultAgent(added, "process.exec", codex.id)).toBe(added);
  });

  it("a step that already names a profile is not overwritten", () => {
    expect(stepNamesProfile(DOC, "plan")).toBe(true);
    expect(
      withProjectDefaultAgent({ ok: true, text: DOC, changed: ["plan"] }, "agent.acp", codex.id),
    ).toEqual({ ok: true, text: DOC, changed: ["plan"] });
  });

  it("an empty profile is 'none yet', not a name", () => {
    const blank = DOC.replace("profile: reviewer", 'profile: ""');
    expect(stepNamesProfile(blank, "plan")).toBe(false);
  });

  it("a step inside a scope body is still found", () => {
    const scoped = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: flow
spec:
  nodes:
    - id: loop
      kind: until
      config:
        maxIterations: 2
        passWhen: "true"
        body:
          nodes:
            - id: inner
              kind: agent.acp
              config:
                profile: keep
`;
    expect(stepNamesProfile(scoped, "inner")).toBe(true);
    expect(stepNamesProfile(scoped, "loop")).toBe(false);
    expect(stepNamesProfile(scoped, "missing")).toBe(false);
  });

  it("a document that cannot be read is changed by nothing", () => {
    expect(
      withProjectDefaultAgent(
        { ok: true, text: "spec:\n  nodes: [:::\n", changed: ["plan"] },
        "agent.acp",
        codex.id,
      ).ok,
    ).toBe(true);
    expect(stepNamesProfile("not: [valid: yaml", "plan")).toBe(true);
  });

  it("a failed op is returned as it came", () => {
    const failed = { ok: false, error: "no" } as const;
    expect(withProjectDefaultAgent(failed, "agent.acp", codex.id)).toBe(failed);
  });
});
