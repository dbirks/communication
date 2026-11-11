/**
 * Transcript projection tests: the journal is the transcript (ADR-0016 §1), so
 * what matters is that a replayed or chunked stream folds into one honest view —
 * merged agent text, tool calls updated in place, and an `interrupted` turn that
 * says "outcome unknown" instead of pretending nothing happened (J7).
 */
import { describe, expect, it } from "vitest";
import {
  automationViaWords,
  formatElapsed,
  interruptedCopy,
  meaningfulPreview,
  planDocumentOf,
  projectTranscript,
  submitterCopy,
  toolTimingLabel,
  turnStatusText,
} from "./transcript";
import { conversationEvent, turnFixture, turnId } from "../test/fakes";
import type { EventEnvelope } from "./types";

function frames(...pairs: Array<[string, Record<string, unknown>, number?]>): EventEnvelope[] {
  return pairs.map(([type, payload, seq], index) =>
    conversationEvent(type, payload, { global_seq: seq ?? index + 1 }),
  ) as EventEnvelope[];
}

/** The muted system lines in order — the reading line of a turn's end is the last. */
function systemLineTexts(transcript: ReturnType<typeof projectTranscript>): string[] {
  return transcript.items.flatMap((item) => (item.kind === "system" ? [item.text] : []));
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

  describe("tool timing (the design's diffstat slot — journal time only)", () => {
    it("formats elapsed journal spans like the slot: <1s, 14s, 1m 05s", () => {
      expect(formatElapsed(999)).toBe("<1s");
      expect(formatElapsed(1000)).toBe("1s");
      expect(formatElapsed(14_000)).toBe("14s");
      expect(formatElapsed(65_000)).toBe("1m 05s");
      expect(formatElapsed(600_000)).toBe("10m 00s");
      expect(formatElapsed(3_600_000 + 5 * 60_000)).toBe("1h 05m");
    });

    it("records first and last occurred_at per call and shows the elapsed span when finished", () => {
      const t0 = "2026-10-14T18:00:00Z";
      const transcript = projectTranscript([
        conversationEvent(
          "conversation.tool.call",
          { tool_call_id: "t-timing", title: "pnpm test", kind: "exec", status: "in_progress" },
          { global_seq: 1, occurred_at: t0 },
        ),
        conversationEvent(
          "conversation.tool.update",
          { tool_call_id: "t-timing", status: "in_progress", update_seq: 1 },
          { global_seq: 2, occurred_at: "2026-10-14T18:00:05Z" },
        ),
        conversationEvent(
          "conversation.tool.update",
          { tool_call_id: "t-timing", status: "completed", output_preview: "ok", update_seq: 2 },
          { global_seq: 3, occurred_at: "2026-10-14T18:00:14Z" },
        ),
      ]);
      const tool = transcript.items.find((item) => item.kind === "tool");
      expect(tool?.kind === "tool" && tool.startedAt).toBe(t0);
      expect(tool?.kind === "tool" && tool.lastAt).toBe("2026-10-14T18:00:14Z");
      expect(tool?.kind === "tool" && tool.finishedAt).toBe("2026-10-14T18:00:14Z");
      expect(tool?.kind === "tool" && toolTimingLabel(tool)).toBe("14s");
    });

    it("keeps a running call on the running marker — never a guessed number", () => {
      const transcript = projectTranscript([
        conversationEvent(
          "conversation.tool.call",
          { tool_call_id: "t-live", title: "go build ./...", kind: "exec", status: "in_progress" },
          { global_seq: 10, occurred_at: "2026-10-14T18:00:00Z" },
        ),
      ]);
      const tool = transcript.items.find((item) => item.kind === "tool");
      expect(tool?.kind === "tool" && tool.finishedAt).toBeNull();
      expect(tool?.kind === "tool" && toolTimingLabel(tool)).toBe("● running");
    });

    it("pins the finish at the first terminal report; a late update moves only lastAt", () => {
      const transcript = projectTranscript([
        conversationEvent(
          "conversation.tool.call",
          { tool_call_id: "t-pinned", title: "edit", kind: "edit", status: "in_progress" },
          { global_seq: 20, occurred_at: "2026-10-14T18:00:00Z" },
        ),
        conversationEvent(
          "conversation.tool.update",
          { tool_call_id: "t-pinned", status: "completed", update_seq: 1 },
          { global_seq: 21, occurred_at: "2026-10-14T18:00:05Z" },
        ),
        conversationEvent(
          "conversation.tool.update",
          {
            tool_call_id: "t-pinned",
            status: "completed",
            output_preview: " (late)",
            update_seq: 2,
          },
          { global_seq: 22, occurred_at: "2026-10-14T18:00:09Z" },
        ),
      ]);
      const tool = transcript.items.find((item) => item.kind === "tool");
      expect(tool?.kind === "tool" && tool.finishedAt).toBe("2026-10-14T18:00:05Z");
      expect(tool?.kind === "tool" && tool.lastAt).toBe("2026-10-14T18:00:09Z");
      expect(tool?.kind === "tool" && toolTimingLabel(tool)).toBe("5s");
    });

    it("shows the elapsed span of a failed call too — the number is not a verdict", () => {
      const transcript = projectTranscript([
        conversationEvent(
          "conversation.tool.call",
          { tool_call_id: "t-fail", title: "pnpm check", kind: "exec", status: "in_progress" },
          { global_seq: 30, occurred_at: "2026-10-14T18:00:00Z" },
        ),
        conversationEvent(
          "conversation.tool.update",
          { tool_call_id: "t-fail", status: "failed", update_seq: 1 },
          { global_seq: 31, occurred_at: "2026-10-14T18:00:02Z" },
        ),
      ]);
      const tool = transcript.items.find((item) => item.kind === "tool");
      expect(tool?.kind === "tool" && tool.status).toBe("failed");
      expect(tool?.kind === "tool" && toolTimingLabel(tool)).toBe("2s");
    });

    it("an orphan terminal update (its call scrolled out of the window) is honest, not 0s", () => {
      const transcript = projectTranscript([
        conversationEvent(
          "conversation.tool.update",
          { tool_call_id: "t-gone", status: "completed", output_preview: "ok", update_seq: 1 },
          { global_seq: 40, occurred_at: "2026-10-14T18:00:00Z" },
        ),
      ]);
      const tool = transcript.items.find((item) => item.kind === "tool");
      expect(tool?.kind === "tool" && tool.startedAt).toBe("2026-10-14T18:00:00Z");
      expect(tool?.kind === "tool" && toolTimingLabel(tool)).toBe("<1s");
    });
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

  describe("the agent row's writing… ends with the turn (no final flag required)", () => {
    /** A streamed agent message whose turn ends at the named terminal event —
     * no frame ever carries `final: true`, the exact lossy stream that left
     * "writing…" on the row after "Turn completed" printed. */
    const agentThenTerminal = (terminal: string) =>
      frames(
        ["conversation.turn.started", { session_origin: "new" }],
        ["conversation.message.agent", { text: "Half of the answer, " }],
        ["conversation.message.agent", { text: "with no final flag to follow" }],
        [terminal, {}],
      );

    it("keeps the row writing… while the turn is still running", () => {
      const transcript = projectTranscript(
        frames(
          ["conversation.turn.started", { session_origin: "new" }],
          ["conversation.message.agent", { text: "streaming" }],
        ),
      );
      const agent = transcript.items.find((item) => item.kind === "agent");
      expect(agent?.kind === "agent" && agent.final).toBe(false);
    });

    for (const [terminal, status] of [
      ["conversation.turn.completed", "completed"],
      ["conversation.turn.cancelled", "cancelled"],
      ["conversation.turn.failed", "failed"],
      ["conversation.turn.interrupted", "interrupted"],
    ] as const) {
      it(`a ${status} turn ends the row's writing… even without the final chunk flag`, () => {
        const transcript = projectTranscript(agentThenTerminal(terminal));
        const agent = transcript.items.find((item) => item.kind === "agent");
        expect(agent?.kind === "agent" && agent.text).toBe(
          "Half of the answer, with no final flag to follow",
        );
        expect(agent?.kind === "agent" && agent.final).toBe(true);
        // The turn record itself still carries the terminal status.
        expect(transcript.turns[0]?.status).toBe(status);
      });
    }

    it("a terminal line for one turn does not end another turn's row", () => {
      const transcript = projectTranscript(
        frames(
          ["conversation.message.agent", { text: "turn one" }],
          ["conversation.turn.completed", {}],
          [
            "conversation.message.agent",
            { turn_id: "01987b99-1111-7000-8000-abcdef012345", text: "turn two, mid-stream" },
          ],
        ),
      );
      const agents = transcript.items.filter((item) => item.kind === "agent");
      expect(agents.map((agent) => (agent.kind === "agent" ? agent.final : false))).toEqual([
        true,
        false,
      ]);
    });

    it("a final frame that still arrives keeps its flag across the terminal line", () => {
      const transcript = projectTranscript(
        frames(
          ["conversation.message.agent", { text: "full answer", final: true }],
          ["conversation.turn.completed", {}],
        ),
      );
      const agent = transcript.items.find((item) => item.kind === "agent");
      expect(agent?.kind === "agent" && agent.final).toBe(true);
    });
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

  it("prints a repository scope move as its own system line, never agent output", () => {
    const nameOf = (userId: string) => (userId === "u-ada" ? "Ada" : userId);
    const line = (payload: Record<string, unknown>) => {
      const transcript = projectTranscript(
        frames([
          "conversation.scope_changed",
          {
            actor_user_id: "u-ada",
            from_repository_id: null,
            from_repository_name: null,
            to_repository_id: "01987a79-aaaa-7000-8000-abcdef012345",
            to_repository_name: "server",
            ...payload,
          },
        ]),
        nameOf,
      );
      const system = transcript.items.find((item) => item.kind === "system");
      return system?.kind === "system" ? system.text : "";
    };

    // The move names the actor and the repository the row names — the
    // journal row is the transcript's own evidence, the way the agent-switch
    // divider is.
    expect(line({})).toBe("Ada moved this thread to server");
    // Null is the whole project — the unbound answer, not an empty sentence.
    expect(line({ to_repository_id: null, to_repository_name: null })).toBe(
      "Ada moved this thread to the whole project",
    );
    // A row without an actor falls back to the envelope's human — the
    // default directory's "someone (ef012345)" line, never a bare uuid and
    // never an invented name.
    expect(
      projectTranscript(
        frames([
          "conversation.scope_changed",
          {
            actor_user_id: "",
            from_repository_id: "01987a79-aaaa-7000-8000-abcdef012345",
            from_repository_name: "server",
            to_repository_id: "01987a79-bbbb-7000-8000-abcdef012345",
            to_repository_name: "api",
          },
        ]),
      ).items.find((item) => item.kind === "system")?.text,
    ).toBe("someone (ef012345) moved this thread to api");
    expect(
      projectTranscript([
        conversationEvent(
          "conversation.scope_changed",
          {
            actor_user_id: "",
            from_repository_id: "01987a79-aaaa-7000-8000-abcdef012345",
            from_repository_name: "server",
            to_repository_id: null,
            to_repository_name: null,
          },
          { actor: { kind: "system", id: "system" } },
        ),
      ]).items.find((item) => item.kind === "system")?.text,
    ).toBe("Someone moved this thread to the whole project");
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

  it("says a thread started, not a conversation (Projects README: Threads everywhere)", () => {
    // The event type is the wire's own (`conversation.created`) and the payload
    // names the agent profile; the sentence a person reads is the app's, and the
    // Projects handoff renames the noun: “Conversations” becomes “Threads”
    // everywhere (docs/design/handoff-projects/README.md § 1 copy).
    const transcript = projectTranscript(
      frames(["conversation.created", { agent_profile_name: "claude-opus-4-5" }]),
    );
    const line = transcript.items.find((item) => item.kind === "system");
    expect(line?.kind === "system" && line.text).toBe("Thread started with claude-opus-4-5");

    // No profile name on the frame: the honest fallback, still a thread.
    const bare = projectTranscript(frames(["conversation.created", {}]));
    const bareLine = bare.items.find((item) => item.kind === "system");
    expect(bareLine?.kind === "system" && bareLine.text).toBe("Thread started with an agent");
    expect(JSON.stringify(bare.items)).not.toMatch(/conversation started/i);
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

describe("submitted_via (ADR-0062)", () => {
  it("names each automation kind and says nothing for a human turn", () => {
    expect(automationViaWords("issue_trigger")).toBe("issue trigger");
    expect(automationViaWords("schedule")).toBe("schedule");
    expect(automationViaWords("child_run")).toBe("child run");
    // `human` is the plain case, and an absent value is a control plane that
    // predates the column — neither is an automation.
    expect(automationViaWords("human")).toBeNull();
    expect(automationViaWords(undefined)).toBeNull();
    expect(automationViaWords(null)).toBeNull();
    // A kind this build never heard of is still not a person typing, so it is
    // named by its own wire value rather than dropped.
    expect(automationViaWords("webhook")).toBe("webhook");
  });

  it("writes the submitter as the author for a human turn and on behalf of one for an automation", () => {
    expect(submitterCopy("Ada Lovelace", "human")).toBe("Ada Lovelace");
    expect(submitterCopy("Ada Lovelace", undefined)).toBe("Ada Lovelace");
    expect(submitterCopy("Ada Lovelace", "issue_trigger")).toBe(
      "on behalf of Ada Lovelace · issue trigger",
    );
    expect(submitterCopy("Ada Lovelace", "schedule")).toBe("on behalf of Ada Lovelace · schedule");
    expect(submitterCopy("Ada Lovelace", "child_run")).toBe(
      "on behalf of Ada Lovelace · child run",
    );
  });

  it("joins the turn row's submitted_via onto the prompt it describes", () => {
    // The journal frame only ever carries `submitted_by`; the turn row is what
    // says whether that person typed the prompt or authorised an automation.
    const transcript = projectTranscript(
      frames([
        "conversation.message.user",
        { turn_id: turnId, submitted_by: "u1", text: "Ship it" },
      ]),
      undefined,
      [turnFixture({ id: turnId, submitted_by: "u1", submitted_via: "issue_trigger" })],
    );
    const user = transcript.items[0];
    expect(user?.kind === "user" && user.submittedVia).toBe("issue_trigger");
  });

  it("leaves a prompt nobody's turn row explains unqualified", () => {
    const transcript = projectTranscript(
      frames([
        "conversation.message.user",
        { turn_id: "01987a99-9999-7000-8000-abcdef012345", submitted_by: "u1", text: "Ship it" },
      ]),
      undefined,
      // The row belongs to a different turn — the join is by id, not by nearness.
      [turnFixture({ submitted_via: "schedule" })],
    );
    const user = transcript.items[0];
    expect(user?.kind === "user" ? "submittedVia" in user : true).toBe(false);
  });
});

/** `conversation.notice` — the worker's own system line (09-api-events-data).
 * It is a transcript row, never agent output: this turn's answer is quoted to
 * the asking chat from `conversation.message.agent` rows alone (ADR-0072 § 7),
 * so a note that folded into the agent's text would be quoted as if the agent
 * had written it. */
describe("the transcript's system notes (conversation.notice)", () => {
  const mailReadOnlyText =
    "this chat is answering another chat's mail: its repository is mounted read-only in " +
    "the sandbox, and it runs without asking because the sandbox is the boundary " +
    "(ADR-0072 § 12). A person's approval lifts the mount to read-write.";
  const workspaceNote =
    'workspace: mirror /repos/emu/server.git has no branch "main" to base server on ' +
    "(ADR-0017 D2 refuses a branch-name guess)";

  const systemTexts = (items: ReturnType<typeof projectTranscript>["items"]) =>
    items.flatMap((item) => (item.kind === "system" ? [item.text] : []));

  it("folds each notice into its own system line, beside the agent's message", () => {
    const transcript = projectTranscript(
      frames(
        ["conversation.notice", { kind: "workspace", text: workspaceNote }],
        ["conversation.message.agent", { text: "A single README.", final: true }],
        ["conversation.notice", { kind: "mail_readonly", text: mailReadOnlyText }],
      ),
    );

    // The agent's sentence is exactly the agent's, and the notes are lines of
    // their own — one per frame, in commit order.
    expect(transcript.items.map((item) => item.kind)).toEqual(["system", "agent", "system"]);
    const agent = transcript.items[1];
    expect(agent?.kind === "agent" && agent.text).toBe("A single README.");
    expect(systemTexts(transcript.items)).toEqual([
      // The fold has no better words for a workspace note than the worker's, so
      // it prints the worker's line without the wire's prefix — and never an
      // ADR reference, which is not a sentence a member can act on.
      'Workspace: mirror /repos/emu/server.git has no branch "main" to base server on',
      // The read-only note's sentence names a repository the frame does not
      // carry, so the fold stays repository-free; the thread's own row supplies
      // the name (`plainNoticeLines`, transcriptPresentation.ts).
      "Read-only: this agent can't change this repository.",
    ]);
  });

  it("keeps the notice's kind off the visible line and on the tooltip's data", () => {
    const transcript = projectTranscript(
      frames(["conversation.notice", { kind: "mail_readonly", text: mailReadOnlyText }]),
    );
    const note = transcript.items[0];
    expect(note?.kind === "system" && note.noticeKind).toBe("mail_readonly");
    expect(note?.kind === "system" && note.raw).toBe("kind mail_readonly");
  });

  it("renders a kind this build has no words for as the worker's own line", () => {
    // A kind the worker invents later must not be an error, and must not be
    // dropped: an unknown notice is still a system line.
    const transcript = projectTranscript(
      frames([
        "conversation.notice",
        { kind: "sandbox_remounted", text: "workspace: the mount changed under this turn" },
      ]),
    );
    const note = transcript.items[0];
    expect(note?.kind === "system" && note.text).toBe("the mount changed under this turn");
    expect(note?.kind === "system" && note.noticeKind).toBe("sandbox_remounted");
  });

  it("collapses a run of the launcher's retry status lines into one muted line", () => {
    // The round-6 defect on the wire: pi's transport retry state streamed as
    // four agent message chunks. The sink now journals each as a
    // conversation.notice (kind agent_retry); the fold must say it ONCE.
    const transcript = projectTranscript(
      frames(
        ["conversation.message.user", { submitted_by: "u1", text: "Reply with exactly OK" }],
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 1/3, waiting 2s)…" },
        ],
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 2/3, waiting 4s)…" },
        ],
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 3/3, waiting 8s)…" },
        ],
        ["conversation.notice", { kind: "agent_retry", text: "Retry finished, resuming." }],
      ),
    );

    // ONE system line for the whole series — the three attempt lines count,
    // the "resuming" line does not — and none of the wire's lines shows.
    const systems = transcript.items.filter((item) => item.kind === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]?.kind === "system" && systems[0].text).toBe(
      "Retrying the model… (3 attempts)",
    );
    expect(systems[0]?.kind === "system" && systems[0].noticeKind).toBe("agent_retry");
    for (const item of transcript.items) {
      if ("text" in item) {
        expect(item.text).not.toContain("Retrying (attempt");
        expect(item.text).not.toContain("Retry finished");
      }
    }
    // No agent message at all: the series was never the agent's words.
    expect(transcript.items.map((item) => item.kind)).toEqual(["user", "system"]);
  });

  it("keeps the answer after a retry series, and counts a lone attempt line as one", () => {
    // The series streams first, the model resumes and answers: the answer is
    // the agent's own row, and the muted line sits above it, not in it.
    const transcript = projectTranscript(
      frames(
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 1/2, waiting 2s)…" },
        ],
        ["conversation.notice", { kind: "agent_retry", text: "Retry finished, resuming." }],
        ["conversation.message.agent", { text: "OK", final: true }],
      ),
    );
    expect(transcript.items.map((item) => item.kind)).toEqual(["system", "agent"]);
    const system = transcript.items[0];
    expect(system?.kind === "system" && system.text).toBe("Retrying the model… (1 attempt)");
    const agent = transcript.items[1];
    expect(agent?.kind === "agent" && agent.text).toBe("OK");

    // A different run (another turn) after an intervening line starts fresh:
    // two series, two muted lines, each counting its own attempts.
    const second = projectTranscript(
      frames(
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 1/3, waiting 2s)…" },
        ],
        ["conversation.message.agent", { text: "first answer", final: true }],
        ["conversation.message.user", { submitted_by: "u1", text: "again" }],
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 1/3, waiting 2s)…" },
        ],
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 2/3, waiting 4s)…" },
        ],
      ),
    );
    const secondSystems = second.items
      .filter((item) => item.kind === "system")
      .map((item) => (item.kind === "system" ? item.text : ""));
    expect(secondSystems).toEqual([
      "Retrying the model… (1 attempt)",
      "Retrying the model… (2 attempts)",
    ]);
  });

  it("says the model was unavailable when a retried turn completed with nothing said", () => {
    // Deployed finding 2026-11-11 (the pi thread whose README summary never
    // appeared): the model's retries ran out, the agent's whole message stream
    // was whitespace, and the turn still ended `completed` — so the transcript's
    // last line printed "Turn completed" over an empty answer. The retry notices
    // are the journal's own evidence of why, and the line now says it.
    const transcript = projectTranscript(
      frames(
        ["conversation.notice", { kind: "agent_retry", text: "Retrying (attempt 1/3…)" }],
        ["conversation.notice", { kind: "agent_retry", text: "Retrying (attempt 3/3…)" }],
        ["conversation.notice", { kind: "agent_retry", text: "Retry finished, resuming." }],
        ["conversation.turn.completed", { stop_reason: "end_turn" }],
      ),
    );
    expect(systemLineTexts(transcript).at(-1)).toBe(
      "Turn ended without an answer — the model was unavailable (3 retries).",
    );
    // The machine's word stays where it was: the tooltip, not the reading line.
    const completed = transcript.items.at(-1);
    expect(completed?.kind === "system" && completed.raw).toBe("stop_reason end_turn");

    // The same turn with the whitespace answer the deployed stream really
    // carried: still no answer, still the honest line.
    const blank = projectTranscript(
      frames(
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 1/3, waiting 2s)…" },
        ],
        ["conversation.message.agent", { text: "\n\n", final: false }],
        ["conversation.turn.completed", { stop_reason: "end_turn" }],
      ),
    );
    expect(systemLineTexts(blank).at(-1)).toBe(
      "Turn ended without an answer — the model was unavailable (3 retries).",
    );
  });

  it("keeps 'Turn completed' when the retried turn did answer, or when nothing retried", () => {
    // The retry series is only the story when there is no answer to read. An
    // agent that retried and then replied completed, and says so.
    const answered = projectTranscript(
      frames(
        [
          "conversation.notice",
          { kind: "agent_retry", text: "Retrying (attempt 1/3, waiting 2s)…" },
        ],
        ["conversation.notice", { kind: "agent_retry", text: "Retry finished, resuming." }],
        ["conversation.message.agent", { text: "OK", final: true }],
        ["conversation.turn.completed", { stop_reason: "end_turn" }],
      ),
    );
    expect(systemLineTexts(answered).at(-1)).toBe("Turn completed");

    // A completed turn with no retry notices keeps the same line: the new
    // sentence is derived from the journal's own retry notices, never guessed.
    const plain = projectTranscript(
      frames(["conversation.turn.completed", { stop_reason: "end_turn" }]),
    );
    expect(systemLineTexts(plain)).toEqual(["Turn completed"]);
  });

  it("never puts a notice's text in the agent's mouth", () => {
    const transcript = projectTranscript(
      frames(
        ["conversation.message.agent", { text: "Answer.", final: true }],
        ["conversation.notice", { kind: "mail_readonly", text: mailReadOnlyText }],
        ["conversation.notice", { kind: "workspace", text: workspaceNote }],
      ),
    );
    const printed = transcript.items.flatMap((item) => (item.kind === "agent" ? [item.text] : []));
    expect(printed.join(" ")).toBe("Answer.");
    // Nothing on the fold's visible surface quotes the wire's vocabulary.
    for (const line of transcript.items.flatMap((item) => ("text" in item ? [item.text] : []))) {
      expect(line).not.toContain("ADR-");
    }
  });
});
