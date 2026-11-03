/**
 * The two post-fold readings a conversation surface needs (rcn-2e review
 * item 2), proven on plain data: frames, turn records and the derived agent
 * ranges — no React, no stream.
 *
 * The lab case that started this: one organization ran `m4-implementer` and
 * `m4-planner` on the SAME launcher (`pi`). The thread switched profiles
 * between turns 1 and 2, and every `Connected to …` line named the thread's
 * CURRENT profile — so turn 1's session was attributed to the agent that only
 * arrived for turn 2. A launcher cannot name a profile when two profiles share
 * it; the turn the session launched can, because ADR-0068 stamps
 * `agent_profile_id` on the turn row and derives `Conversation.agents` from it.
 */
import { describe, expect, it } from "vitest";
import { conversationEvent, meFixture, turnId } from "../../test/fakes";
import { nameAgentSessionLines, trimAgentMessageLead } from "./transcriptPresentation";
import { projectTranscript } from "../../api/transcript";
import type { TranscriptItem } from "../../api/transcript";

const implementer = "01987a75-1101-7000-8000-000000000001";
const planner = "01987a75-1102-7000-8000-000000000002";
const turnTwo = "01987a75-2202-7000-8000-0000000000aa";

/** Two profiles, one executable — the lab's `pi` pair. */
const agents = [
  { agent_profile_name: "m4-implementer", model: null, first_turn: 1, last_turn: 1 },
  { agent_profile_name: "m4-planner", model: null, first_turn: 2, last_turn: 2 },
];

function system(text: string, id: string): TranscriptItem {
  return { kind: "system", id, text, at: "2026-11-02T22:46:14Z" };
}

describe("nameAgentSessionLines (the Connected-to line names the turn's profile)", () => {
  it("names the profile each turn ran on, not the thread's current one", () => {
    // The reviewed thread, frame for frame: both sessions launch `pi`, the
    // switch lands between the turns, and the fold — which only sees a
    // launcher — prints the current profile for both.
    const events = [
      conversationEvent(
        "agent.session.connected",
        { binding_id: "bind-1", launcher_id: "pi", session_origin: "new" },
        { global_seq: 10 },
      ),
      conversationEvent(
        "conversation.turn.started",
        { turn_id: turnId, binding_id: "bind-1", session_origin: "new" },
        { global_seq: 11 },
      ),
      conversationEvent(
        "conversation.agent.switched",
        {
          actor_user_id: meFixture.id,
          from_agent_profile_id: implementer,
          from_profile_name: "m4-implementer",
          to_agent_profile_id: planner,
          to_profile_name: "m4-planner",
          to_launcher_id: "pi",
          model: null,
          transcript_carried_over: true,
        },
        { global_seq: 12 },
      ),
      conversationEvent(
        "agent.session.connected",
        { binding_id: "bind-2", launcher_id: "pi", session_origin: "new" },
        { global_seq: 13 },
      ),
      conversationEvent(
        "conversation.turn.started",
        { turn_id: turnTwo, binding_id: "bind-2", session_origin: "new" },
        { global_seq: 14 },
      ),
    ];
    const folded = projectTranscript(events, (id) => id);
    const before = folded.items.filter((item) => item.kind === "system");
    expect(before.map((item) => item.kind === "system" && item.text)).toEqual([
      // The fold had nothing better: both frames carry the launcher `pi`,
      // which two profiles share.
      "Connected to pi",
      "Turn started on a new agent session",
      "Connected to pi",
      "Turn started on a new agent session",
    ]);

    const named = nameAgentSessionLines(folded.items, {
      events,
      turns: folded.turns,
      agents,
    });
    expect(
      named.filter((item) => item.kind === "system").map((item) => (item as { text: string }).text),
    ).toEqual([
      "Connected to m4-implementer",
      "Turn started on a new agent session",
      "Connected to m4-planner",
      "Turn started on a new agent session",
    ]);
  });

  it("reads the turn row first: an active turn names its own profile", () => {
    // The row outranks the derived range — it is what the turn was stamped
    // with at enqueue (ADR-0068), and the range is a projection of it.
    const events = [
      conversationEvent(
        "agent.session.connected",
        { binding_id: "bind-9", launcher_id: "pi" },
        { global_seq: 30 },
      ),
      conversationEvent(
        "conversation.turn.started",
        { turn_id: turnId, binding_id: "bind-9" },
        { global_seq: 31 },
      ),
    ];
    const folded = projectTranscript(events, (id) => id);
    const named = nameAgentSessionLines(folded.items, {
      events,
      turns: folded.turns,
      agents,
      turnRows: [{ id: turnId, agent_profile_name: "m4-planner" }],
    });
    expect(named[0]).toMatchObject({ text: "Connected to m4-planner" });
  });

  it("leaves the fold's line alone when nothing reaches the turn", () => {
    // No `turn.started` after the launch (a session opened with no turn yet in
    // flight) and no row: the honest answer is what the fold said — the
    // launcher it was given — never a profile picked out of a hat.
    const events = [
      conversationEvent(
        "agent.session.connected",
        { binding_id: "bind-0", launcher_id: "pi" },
        { global_seq: 40 },
      ),
    ];
    const folded = projectTranscript(events, (id) => id);
    const named = nameAgentSessionLines(folded.items, { events, turns: folded.turns, agents });
    expect(named[0]).toMatchObject({ text: "Connected to pi" });
  });

  it("rewrites nothing on a thread that never switched, and keeps the tooltip", () => {
    // One profile, one launcher: the fold's own answer is already the right
    // one, and the `raw` machine detail (launcher_id …) is not this function's
    // business.
    const events = [
      conversationEvent(
        "agent.session.connected",
        { binding_id: "bind-1", launcher_id: "claude" },
        { global_seq: 50 },
      ),
      conversationEvent(
        "conversation.turn.started",
        { turn_id: turnId, binding_id: "bind-1" },
        { global_seq: 51 },
      ),
    ];
    const folded = projectTranscript(
      events,
      (id) => id,
      [],
      () => "Claude Code",
    );
    const named = nameAgentSessionLines(folded.items, {
      events,
      turns: folded.turns,
      agents: [{ agent_profile_name: "Claude Code", model: "opus", first_turn: 1, last_turn: 1 }],
    });
    expect(named[0]).toMatchObject({ text: "Connected to Claude Code", raw: "launcher_id claude" });
  });
});

describe("trimAgentMessageLead (the speaker line and its sentence, no gap)", () => {
  it("drops the blank lines a turn's first chunk arrives as", () => {
    // The worker flushes its workspace note, then the harness opens its
    // answer with newlines; `whitespace-pre-wrap` printed them as ~40px of
    // empty column between `agent · time` and the sentence.
    const items: TranscriptItem[] = [
      {
        kind: "agent",
        id: "a-1",
        turnId,
        text: "\n\n\n\nOK",
        truncated: false,
        final: true,
        at: "2026-11-02T22:46:14Z",
      },
    ];
    expect(trimAgentMessageLead(items)[0]).toMatchObject({ text: "OK" });
  });

  it("keeps the agent's own formatting: interior gaps and an indented first line", () => {
    const items: TranscriptItem[] = [
      {
        kind: "agent",
        id: "a-2",
        turnId,
        text: "  first line\n\nsecond paragraph",
        truncated: false,
        final: true,
        at: "2026-11-02T22:46:14Z",
      },
    ];
    expect(trimAgentMessageLead(items)[0]).toMatchObject({
      text: "  first line\n\nsecond paragraph",
    });
  });

  it("returns the same items when none of them leads with blank lines", () => {
    const items: TranscriptItem[] = [
      {
        kind: "agent",
        id: "a-3",
        turnId,
        text: "plain",
        truncated: false,
        final: false,
        at: "2026-11-02T22:46:14Z",
      },
      system("Turn completed", "s-1"),
    ];
    expect(trimAgentMessageLead(items)).toBe(items);
  });
});
