/**
 * The switch divider's copy is ADR-0068 § 3's sentence, rendered from the
 * journal row and nothing else. These cases pin the wording and the honesty
 * rules: no model → no ` · <model>` segment; `transcript_carried_over` is
 * printed only as the row reports it; a uuid is never printed as a person.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSwitchCopy, AgentSwitchDivider, agentSwitchFromEvent } from "./AgentSwitchDivider";
import { conversationEvent, envelopeFixture, meFixture } from "../../test/fakes";
import type { EventEnvelope } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("agentSwitchCopy", () => {
  it("spells the ADR sentence exactly", () => {
    expect(agentSwitchCopy("Dana", "Codex", "gpt-5", true)).toBe(
      "Dana switched to Codex · gpt-5 · transcript and branch carried over",
    );
  });

  it("drops the model segment when the profile names none", () => {
    expect(agentSwitchCopy("Dana", "Codex", null, true)).toBe(
      "Dana switched to Codex · transcript and branch carried over",
    );
  });

  it("drops the carried-over tail when the row does not report it", () => {
    expect(agentSwitchCopy("Dana", "Codex", "gpt-5", false)).toBe("Dana switched to Codex · gpt-5");
  });
});

describe("agentSwitchFromEvent", () => {
  function switchEvent(payload: Record<string, unknown>): EventEnvelope {
    return conversationEvent(
      "conversation.agent.switched",
      { turn_id: undefined, actor_user_id: meFixture.id, ...payload },
      {},
    );
  }

  it("reads person, agent and model off the row and names the actor", () => {
    const props = agentSwitchFromEvent(
      switchEvent({
        to_profile_name: "Codex",
        model: "gpt-5",
        transcript_carried_over: true,
      }),
      (id) => (id === meFixture.id ? "Ada Lovelace" : `someone (${id.slice(0, 8)})`),
    );
    expect(props).toEqual({
      person: "Ada Lovelace",
      agent: "Codex",
      model: "gpt-5",
      carriedOver: true,
    });
  });

  it("says Someone for a row that names no actor instead of inventing or printing an id", () => {
    const bare = envelopeFixture({
      type: "conversation.agent.switched",
      conversation_id: "01987a70-1111-7000-8000-abcdef012345",
      actor: { kind: "system", id: "system" },
      payload: { to_profile_name: "Codex", transcript_carried_over: true },
    });
    const props = agentSwitchFromEvent(bare, () => "nobody");
    expect(props.person).toBe("Someone");
  });
});

describe("AgentSwitchDivider", () => {
  it("renders the centred mono sentence", () => {
    render(<AgentSwitchDivider person="Dana" agent="Codex" model="gpt-5" carriedOver />);
    const divider = screen.getByTestId("agent-switch-divider");
    expect(divider.textContent).toBe(
      "Dana switched to Codex · gpt-5 · transcript and branch carried over",
    );
    // centred, mono: the sentence sits on a mono centred span between two rules.
    const label = divider.children[1] as HTMLElement;
    expect(label.className).toContain("font-mono");
    expect(label.className).toContain("text-center");
    expect(divider.querySelector("[aria-hidden]")).toBeTruthy();
  });
});
