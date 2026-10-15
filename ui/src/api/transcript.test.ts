/**
 * Transcript projection tests: the journal is the transcript (ADR-0016 §1), so
 * what matters is that a replayed or chunked stream folds into one honest view —
 * merged agent text, tool calls updated in place, and an `interrupted` turn that
 * says "outcome unknown" instead of pretending nothing happened (J7).
 */
import { describe, expect, it } from "vitest";
import { interruptedCopy, projectTranscript, turnStatusText } from "./transcript";
import { conversationEvent, turnId } from "../test/fakes";
import type { EventEnvelope } from "./types";

function frames(...pairs: Array<[string, Record<string, unknown>, number?]>): EventEnvelope[] {
  return pairs.map(([type, payload, seq], index) =>
    conversationEvent(type, payload, { global_seq: seq ?? index + 1 }),
  ) as EventEnvelope[];
}

describe("projectTranscript", () => {
  it("renders a user prompt and merges streamed agent chunks into one message", () => {
    const transcript = projectTranscript(
      frames(
        ["conversation.message.user", { submitted_by: "u1", text: "Fix the flaky test" }],
        ["conversation.message.agent", { chunk_seq: 1, text: "Looking at " }],
        ["conversation.message.agent", { chunk_seq: 2, text: "the failing spec" }],
        ["conversation.message.agent", { chunk_seq: 3, text: " now.", final: true }],
      ),
    );

    expect(transcript.items.map((item) => item.kind)).toEqual(["user", "agent"]);
    const agent = transcript.items[1];
    expect(agent?.kind === "agent" && agent.text).toBe("Looking at the failing spec now.");
    expect(agent?.kind === "agent" && agent.final).toBe(true);
  });

  it("keeps separate agent messages for separate turns", () => {
    const transcript = projectTranscript([
      conversationEvent("conversation.message.agent", { text: "first" }, { global_seq: 1 }),
      conversationEvent(
        "conversation.message.agent",
        { text: "second", turn_id: "01987a99-9999-7000-8000-abcdef012345" },
        { global_seq: 2 },
      ),
    ]);
    expect(transcript.items).toHaveLength(2);
  });

  it("updates a tool call in place instead of appending a second row", () => {
    const transcript = projectTranscript(
      frames(
        [
          "conversation.tool.call",
          {
            tool_call_id: "t1",
            title: "Edit api.go",
            kind: "edit",
            status: "in_progress",
            input_preview: "package api",
          },
        ],
        [
          "conversation.tool.update",
          { tool_call_id: "t1", status: "completed", output_preview: "ok", update_seq: 1 },
        ],
        [
          "conversation.tool.update",
          { tool_call_id: "t1", status: "completed", output_preview: " (done)", update_seq: 2 },
        ],
      ),
    );

    const tools = transcript.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool?.kind === "tool" && tool.status).toBe("completed");
    expect(tool?.kind === "tool" && tool.outputPreview).toBe("ok (done)");
  });

  it("closes a permission card when the decision event arrives", () => {
    const transcript = projectTranscript(
      frames(
        [
          "conversation.permission.requested",
          {
            permission_request_id: "p1",
            title: "Write to api.go",
            kind: "edit",
            options: [{ option_id: "allow_once", label: "Allow once", kind: "allow_once" }],
          },
        ],
        [
          "conversation.permission.decided",
          {
            permission_request_id: "p1",
            status: "decided",
            decision_option_id: "allow_once",
            decided_by: "u1",
          },
        ],
      ),
    );

    const card = transcript.items.find((item) => item.kind === "permission");
    expect(card?.kind === "permission" && card.status).toBe("decided");
    expect(card?.kind === "permission" && card.decisionOptionId).toBe("allow_once");
  });

  it("does not duplicate frames replayed at the same global_seq", () => {
    const a = conversationEvent("conversation.message.agent", { text: "hello" }, { global_seq: 7 });
    const transcript = projectTranscript([a, a, a]);
    expect(transcript.items).toHaveLength(1);
    expect(transcript.throughSeq).toBe(7);
  });

  it("tracks turn state, and marks an interrupted turn with no stop reason", () => {
    const transcript = projectTranscript(
      frames(
        [
          "conversation.turn.started",
          { worker_id: "w1", fencing_token: 41, session_origin: "new" },
        ],
        ["conversation.turn.interrupted", { reason: "lease_expired" }],
      ),
    );

    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]?.status).toBe("interrupted");
    expect(transcript.turns[0]?.stopReason).toBeNull();
    expect(transcript.turns[0]?.interruptReason).toBe("lease_expired");
    // Never leak the fencing token into a human-facing line.
    expect(JSON.stringify(transcript.items)).not.toContain("fencing");
  });

  it("says how each turn met its session — new, reused and resumed are distinct copy", () => {
    const copies: Record<string, string> = {
      new: "Turn started on a new agent session",
      reused: "Turn continued on the live agent session",
      resumed: "Turn started on a resumed agent session",
    };
    for (const [origin, copy] of Object.entries(copies)) {
      const transcript = projectTranscript(
        frames(["conversation.turn.started", { session_origin: origin }]),
      );
      const system = transcript.items.find((item) => item.kind === "system");
      expect(system?.kind === "system" && system.text).toBe(copy);
    }
  });

  it("describes the active turn from the API row, which outranks the journal", () => {
    const transcript = projectTranscript(
      frames(["conversation.turn.started", { session_origin: "new" }]),
    );
    expect(
      turnStatusText(transcript.turns, {
        id: turnId,
        conversation_id: "c1",
        status: "running",
        submitted_by: "u1",
        created_at: "2026-10-14T18:00:00Z",
        cancel_requested_at: "2026-10-14T18:01:00Z",
      }),
    ).toBe("running — stop requested, waiting for the agent");
  });

  it("says an interrupted turn was stopped with an unknown outcome, never resumed", () => {
    expect(interruptedCopy("worker_gone")).toContain("outcome unknown");
    expect(interruptedCopy("worker_gone")).toContain("the worker disappeared");
    expect(interruptedCopy(null)).toBe("Turn stopped — outcome unknown; you can send a new prompt");
    expect(interruptedCopy("shutdown").toLowerCase()).not.toContain("resumed");
    expect(
      turnStatusText([
        {
          turnId: "t",
          status: "interrupted",
          stopReason: null,
          interruptReason: "lease_expired",
          requestedBy: null,
          sessionOrigin: null,
          startedAt: null,
        },
      ]),
    ).toBe("stopped — outcome unknown");
  });
});
