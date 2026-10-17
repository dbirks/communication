/**
 * Transcript projection tests: the journal is the transcript (ADR-0016 §1), so
 * what matters is that a replayed or chunked stream folds into one honest view —
 * merged agent text, tool calls updated in place, and an `interrupted` turn that
 * says "outcome unknown" instead of pretending nothing happened (J7).
 */
import { describe, expect, it } from "vitest";
import {
  interruptedCopy,
  meaningfulPreview,
  planDocumentOf,
  projectTranscript,
  turnStatusText,
} from "./transcript";
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

  it("names the humans in a control transfer instead of printing uuids", () => {
    const nameOf = (userId: string) => (userId === "u-ada" ? "Ada" : userId);
    const line = (payload: Record<string, unknown>) => {
      const transcript = projectTranscript(
        frames(["conversation.control.transferred", payload]),
        nameOf,
      );
      const system = transcript.items.find((item) => item.kind === "system");
      return system?.kind === "system" ? system.text : "";
    };

    expect(line({ to_kind: "human", to_user_id: "u-ada", reason: "taken" })).toBe(
      "Control taken by Ada",
    );
    expect(line({ to_kind: "human", to_user_id: "u-ada", reason: "returned" })).toBe(
      "Control returned to Ada",
    );
    expect(line({ to_kind: "human", to_user_id: "u-ada", reason: "claimed" })).toContain("Ada");
    // A run attempt is not a person, so no name is invented for it (`to_kind` is
    // `human`, `run_attempt` or `none` in `api/openapi.yaml`).
    expect(line({ to_kind: "run_attempt", to_user_id: "u-ada", reason: "taken" })).not.toContain(
      "Ada",
    );
    expect(line({ to_kind: "run_attempt", reason: "taken" })).toContain("run attempt");
    // Nobody holding control is its own sentence, not an empty name.
    expect(line({ to_kind: "none", reason: "released" })).toContain("nobody is driving");
    // Without a directory entry, the id is shown rather than a guess.
    const raw = projectTranscript(
      frames([
        "conversation.control.transferred",
        { to_kind: "human", to_user_id: "u-zoe", reason: "taken" },
      ]),
    );
    const sys = raw.items.find((item) => item.kind === "system");
    expect(sys?.kind === "system" && sys.text).toContain("u-zoe");
  });

  it("suppresses an empty tool input rather than rendering raw braces", () => {
    const spellings = ["{}", " { } ", "[]", "null", "", '{"a":1}'];
    const transcript = projectTranscript(
      spellings.map((input, index) =>
        conversationEvent(
          "conversation.tool.call",
          {
            tool_call_id: `tc-${index}`,
            title: "run tests",
            kind: "execute",
            status: "completed",
            input_preview: input,
            output_preview: input,
          },
          { global_seq: 100 + index },
        ),
      ),
    );
    const tools = transcript.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(spellings.length);
    // A JSON container with no members is no content, in any whitespace spelling.
    for (const tool of tools.slice(0, 4)) {
      expect(tool.kind === "tool" && tool.inputPreview).toBe("");
      expect(tool.kind === "tool" && tool.outputPreview).toBe("");
    }
    expect(tools[5]?.kind === "tool" && tools[5]?.inputPreview).toContain('"a":1');
  });

  it("names whoever decided a permission, and says so once the card closes", () => {
    const transcript = projectTranscript(
      frames(
        [
          "conversation.permission.requested",
          {
            permission_request_id: "req-1",
            tool_call_id: "tc-1",
            title: "write file",
            kind: "edit",
            options: [{ option_id: "allow_once", label: "Allow once", kind: "allow_once" }],
            deadline_at: "2026-10-14T18:05:00Z",
          },
        ],
        [
          "conversation.permission.decided",
          {
            permission_request_id: "req-1",
            status: "decided",
            decision_option_id: "allow_once",
            decided_by: "u-ada",
          },
        ],
      ),
      (userId) => (userId === "u-ada" ? "Ada" : userId),
    );
    const card = transcript.items.find((item) => item.kind === "permission");
    expect(card?.kind === "permission" && card.status).toBe("decided");
    expect(card?.kind === "permission" && card.decidedBy).toBe("u-ada");
    // The card keeps the id; `Transcript` is what turns it into "decided by Ada".
    expect(card?.kind === "permission" && card.decidedBy).toBe("u-ada");

    // A decision whose request scrolled out of the retained window is still
    // named, because that system line is the only trace of who closed it.
    const orphan = projectTranscript(
      frames([
        "conversation.permission.decided",
        { permission_request_id: "gone", status: "expired", decided_by: "u-ada" },
      ]),
      (userId) => (userId === "u-ada" ? "Ada" : userId),
    );
    const line = orphan.items.find((item) => item.kind === "system");
    expect(line?.kind === "system" && line.text).toContain("decided by Ada");
    expect(line?.kind === "system" && line.text).not.toMatch(/u-ada|[0-9a-f]{8}-/);
  });

  it("names the policy when a policy, not a person, decided (ADR-0039)", () => {
    const orphan = projectTranscript(
      frames([
        "conversation.permission.decided",
        {
          permission_request_id: "gone",
          status: "decided",
          decision_option_id: "allow",
          decided_by: "profile_policy:preapproved_within_sandbox",
        },
      ]),
    );
    const line = orphan.items.find((item) => item.kind === "system");
    expect(line?.kind === "system" && line.text).toBe(
      "Permission decided (allow) — decided by the profile's preapproved policy (sandboxed)",
    );
    expect(line?.kind === "system" && line.text).not.toMatch(/profile_policy/);

    const node = projectTranscript(
      frames(
        [
          "conversation.permission.requested",
          {
            permission_request_id: "req-p",
            title: "run command",
            kind: "bash",
            options: [{ option_id: "reject", label: "Reject", kind: "reject" }],
          },
        ],
        [
          "conversation.permission.decided",
          {
            permission_request_id: "req-p",
            status: "decided",
            decision_option_id: "reject",
            decided_by: "node_policy:deny",
          },
        ],
      ),
    );
    const card = node.items.find((item) => item.kind === "permission");
    // The card keeps the raw decider id; `Transcript` renders it in words
    // through `deciderLabel` (covered in actors.test.ts).
    expect(card?.kind === "permission" && card.decidedBy).toBe("node_policy:deny");
  });
});

describe("meaningfulPreview", () => {
  it("keeps real content and drops empty containers", () => {
    expect(meaningfulPreview('{"path":"a.go"}')).toContain("a.go");
    expect(meaningfulPreview("plain text")).toBe("plain text");
    for (const empty of ["", "   ", "{}", "{ }", "[]", "null", '""']) {
      expect(meaningfulPreview(empty)).toBe("");
    }
  });

  it("survives input that is not valid JSON", () => {
    expect(meaningfulPreview("{oops")).toBe("{oops");
    expect(meaningfulPreview(undefined as unknown as string)).toBe("");
  });
});

describe("planDocumentOf", () => {
  // The body a real m4-planner turn served (`live-conversation-3.png`): the
  // whole final message is one JSON document, so the wall of escaped text the
  // transcript printed is the plan.
  const plan = {
    goal: "Document and fix add() in app/hello.py",
    steps: [
      { id: 1, file: "app/hello.py", action: "Add a docstring to add()" },
      { id: 2, file: "app/tests/test_hello.py", action: "Correct the assertion" },
    ],
    risks: ["If the contract requires the test file to stay unchanged, steps 1-2 conflict."],
  };

  it("reads the {plan:{goal,steps}} envelope a planner turn answers with", () => {
    const document = planDocumentOf(JSON.stringify({ plan }));
    expect(document).not.toBeNull();
    // The plan itself reaches PlanView, not the envelope: `plan` as one opaque
    // member is the wall of text this closes.
    const body = JSON.parse(document?.body ?? "{}") as Record<string, unknown>;
    expect(body["goal"]).toBe(plan.goal);
    expect(Array.isArray(body["steps"])).toBe(true);
  });

  it("reads a message that is the plan object directly", () => {
    const text = JSON.stringify(plan);
    expect(planDocumentOf(text)?.body).toBe(text.trim());
  });

  it("reads a plan carried as a JSON string", () => {
    expect(planDocumentOf(JSON.stringify({ plan: JSON.stringify(plan) }))?.body).toContain(
      "Document and fix add()",
    );
  });

  it("leaves prose, half-received JSON and other documents as text", () => {
    // Ordinary narration is untouched, and a chunk still streaming is not a
    // plan nobody served.
    expect(planDocumentOf("Reading the failing spec now.")).toBeNull();
    expect(planDocumentOf('{"goal": "Docume')).toBeNull();
    // JSON with neither goal nor steps is some other payload — a result, an
    // error body — and dressing it as a plan would invent structure.
    expect(planDocumentOf(JSON.stringify({ status: "ok", diff: "--- a" }))).toBeNull();
    expect(planDocumentOf("")).toBeNull();
    expect(planDocumentOf(undefined as unknown as string)).toBeNull();
  });
});
