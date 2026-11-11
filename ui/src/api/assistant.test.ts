/**
 * `api/assistant.ts` — the wire boundary the popover builds on. The message
 * mapper narrows the opaque generated `payload` into the local kind-
 * discriminated shape and drops (never half-renders) rows that lack the
 * fields their kind promises; `assistantContextOf` names the page a turn
 * runs in; `assistantNotConfigured` reads the part-1 failure code.
 */
import { describe, expect, it } from "vitest";
import {
  appPathFromTargetRef,
  assistantContextOf,
  assistantNotConfigured,
  mapAssistantMessage,
  mapAssistantMessageList,
  navigateTargetOf,
} from "./assistant";
import type { AssistantMessage as LocalMessage } from "../components/assistant/types";
import { ApiError } from "./client";
import type { components } from "./schema";

type Wire = components["schemas"]["AssistantMessage"];

function wireRow(kind: Wire["kind"], payload: Record<string, unknown>, id = "m-1"): Wire {
  return { id, kind, payload, created_at: "2026-07-07T00:00:01Z" };
}

describe("mapAssistantMessage", () => {
  it("maps a user row, keeping the context it carries", () => {
    const row = wireRow("user", {
      kind: "user",
      text: "what is failing here?",
      context: {
        route: "/p/proj-1/runs",
        project_id: "proj-1",
        entity: { kind: "run", id: "run-9" },
      },
    });
    expect(mapAssistantMessage(row)).toEqual({
      id: "m-1",
      kind: "user",
      payload: {
        kind: "user",
        text: "what is failing here?",
        context: {
          route: "/p/proj-1/runs",
          project_id: "proj-1",
          entity: { kind: "run", id: "run-9" },
        },
      },
      created_at: "2026-07-07T00:00:01Z",
    });
  });

  it("maps an assistant row with its links and tool calls", () => {
    const row = wireRow("assistant", {
      kind: "assistant",
      turn_id: "01TURN",
      answer_markdown: "Two runs wait on you.",
      links: [
        { label: "Open the board", route: "/board" },
        // A pre-ADR-0050 transcript row: the server stored `href` then — the
        // mapper tolerates it into the route vocabulary.
        { label: "Legacy inbox", href: "/inbox" },
        { label: "missing route" },
      ],
      tool_calls: [
        { name: "run.list", summary: "Listed 3 runs.", ok: true },
        { name: "run.get", summary: "Could not read the run.", ok: false, reason: "not_found" },
        // A call whose server predates ADR-0050's summary field: kept, with
        // the tool name standing in for the missing summary.
        { name: "run.list", ok: true },
      ],
      degraded: null,
    });
    expect(mapAssistantMessage(row)).toEqual({
      id: "m-1",
      kind: "assistant",
      payload: {
        kind: "assistant",
        turn_id: "01TURN",
        answer_markdown: "Two runs wait on you.",
        links: [
          { label: "Open the board", route: "/board" },
          { label: "Legacy inbox", route: "/inbox" },
        ],
        tool_calls: [
          { name: "run.list", summary: "Listed 3 runs.", ok: true },
          {
            name: "run.get",
            summary: "Could not read the run.",
            ok: false,
            reason: "not_found",
          },
          { name: "run.list", summary: "run.list", ok: true },
        ],
        degraded: null,
      },
      created_at: "2026-07-07T00:00:01Z",
    });
  });

  it("maps question and change rows from the payload discriminator", () => {
    const question = mapAssistantMessage(
      wireRow("assistant", {
        kind: "question",
        prompt: "Which fix do you want?",
        options: [{ label: "Patch it", value: "patch" }, { label: "not an option" }],
        allow_free_text: true,
      }),
    );
    expect(question?.payload).toEqual({
      kind: "question",
      turn_id: null,
      prompt: "Which fix do you want?",
      options: [{ label: "Patch it", value: "patch" }],
      allow_free_text: true,
      answered_by: null,
    });
    expect(question?.kind).toBe("question");

    const change = mapAssistantMessage(
      wireRow("assistant", {
        kind: "change",
        change_id: "chg-1",
        change_kind: "draft_edit",
        target_ref: "draft:d-1",
        summary: "Edited the acceptance criteria.",
        undoable: true,
      }),
    );
    expect(change?.payload).toEqual({
      kind: "change",
      change_id: "chg-1",
      change_kind: "draft_edit",
      target_ref: "draft:d-1",
      summary: "Edited the acceptance criteria.",
      undoable: true,
    });
  });

  it("maps the five setup change kinds of CONTRACT §5", () => {
    // The server records these kinds for the handoff §6 setup tools; the wire
    // boundary must name them or the transcript drops the row and the change
    // chip never shows the write that just happened.
    for (const kind of [
      "project_create",
      "repo_add",
      "assignment_set",
      "run_cancel",
      "schedule_create",
    ] as const) {
      const row = mapAssistantMessage(
        wireRow("change", {
          kind: "change",
          change_id: `chg-${kind}`,
          change_kind: kind,
          target_ref: `project:p-1`,
          summary: "Created the project Beluga.",
          undoable: false,
        }),
      );
      expect(row?.payload).toEqual({
        kind: "change",
        change_id: `chg-${kind}`,
        change_kind: kind,
        target_ref: "project:p-1",
        summary: "Created the project Beluga.",
        undoable: false,
      });
    }
  });

  it("maps approval rows and drops anything that is too thin to render", () => {
    const request = mapAssistantMessage(
      wireRow("approval_request", {
        kind: "approval_request",
        turn_id: "01TURN",
        action: "run.retry",
        summary: "Retry the failed run",
        risk: "spends compute",
        state: "pending",
      }),
    );
    expect(request?.payload).toEqual({
      kind: "approval_request",
      turn_id: "01TURN",
      action: "run.retry",
      summary: "Retry the failed run",
      risk: "spends compute",
      state: "pending",
    });

    // The legacy `approval_response` ack kind is gone from the wire (the
    // decision rides the `approval_request` row's own state now); a row
    // still carrying it is dropped, not half-rendered.
    expect(
      mapAssistantMessage(wireRow("assistant", { kind: "approval_response", turn_id: "t" })),
    ).toBeNull();

    // Too thin to render honestly: dropped, not cast.
    expect(mapAssistantMessage(wireRow("user", {}))).toBeNull();
    expect(
      mapAssistantMessage(wireRow("assistant", { kind: "assistant", answer_markdown: null })),
    ).toBeNull();
    // A kind the UI does not name is dropped, too.
    expect(mapAssistantMessage(wireRow("assistant", { kind: "mystery", text: "x" }))).toBeNull();
    expect(
      mapAssistantMessage(
        wireRow("approval_request", {
          kind: "approval_request",
          action: "run.retry",
          summary: "Retry",
          state: "stale",
        }),
      ),
    ).toBeNull();
    expect(
      mapAssistantMessage(
        wireRow("assistant", {
          kind: "change",
          change_id: "chg-1",
          change_kind: "reformat",
          target_ref: "draft:d-1",
          summary: "unknown kind",
          undoable: true,
        }),
      ),
    ).toBeNull();
  });

  it("drops the unrenderable rows of a list and keeps the order", () => {
    const list = mapAssistantMessageList({
      messages: [
        wireRow("user", { kind: "user", text: "hello" }, "a"),
        wireRow("user", {}, "b"),
        wireRow(
          "assistant",
          { kind: "assistant", answer_markdown: "hi", links: [], tool_calls: [] },
          "c",
        ),
      ],
      next_cursor: null,
    });
    expect(list.map((message) => message.id)).toEqual(["a", "c"]);
  });
});

describe("assistantContextOf", () => {
  it("names the page a turn runs in, and the entity when the page is about one", () => {
    expect(assistantContextOf("/")).toEqual({ route: "/" });
    expect(assistantContextOf("/p/proj-1/runs")).toEqual({
      route: "/p/proj-1/runs",
      project_id: "proj-1",
    });
    expect(assistantContextOf("/runs/run-9")).toEqual({
      route: "/runs/run-9",
      project_id: undefined,
      entity: { kind: "run", id: "run-9" },
    });
    expect(assistantContextOf("/workflows/pl-1/drafts/draft-2")).toEqual({
      route: "/workflows/pl-1/drafts/draft-2",
      project_id: undefined,
      entity: { kind: "draft", id: "draft-2" },
    });
  });
});

describe("assistantNotConfigured", () => {
  it("reads the degraded code off the problem body", () => {
    const notConfigured = {
      type: "https://communication.dev/errors/assistant-not-configured",
      title: "Assistant unavailable",
      status: 503,
      detail: "No model base URL is configured.",
      degraded: "assistant_not_configured",
    };
    const timedOut = {
      type: "https://communication.dev/errors/assistant-degraded",
      title: "Degraded",
      status: 502,
      detail: "model timed out",
      degraded: "model_timeout",
    };
    expect(assistantNotConfigured(new ApiError(notConfigured as never, notConfigured))).toBe(true);
    expect(assistantNotConfigured(new ApiError(timedOut as never, timedOut))).toBe(false);
    expect(assistantNotConfigured(new Error("boom"))).toBe(false);
  });
});

/**
 * Finding F-1 (docs/testing/assistant-exercise-2026-11-11.md): ADR-0050
 * Decision 7 says the CLIENT performs a `ui.navigate`, and the turn's
 * `navigate` change row carries the route in `target_ref`. These two helpers are
 * the client's half of that: the shape re-check, and picking the ONE navigation
 * a turn asked for. The server owns the route ALLOWLIST
 * (`internal/assistant/routes.go`); the client's check is that the row names a
 * same-origin relative app path at all — an absolute URL, a protocol-relative
 * host or a path with a control character in it is nothing to move the screen
 * for, whatever the transcript claims.
 */
describe("appPathFromTargetRef", () => {
  it("accepts an app route the server's allowlist could have written", () => {
    expect(appPathFromTargetRef("/ops")).toBe("/ops");
    expect(appPathFromTargetRef("/p/01PROJECT/threads/t-9")).toBe("/p/01PROJECT/threads/t-9");
    // A deep link keeps its query and fragment: same origin, still this app.
    expect(appPathFromTargetRef("/runs/r-1?tab=steps")).toBe("/runs/r-1?tab=steps");
    expect(appPathFromTargetRef("/assistant")).toBe("/assistant");
  });

  it("refuses anything that would leave the app", () => {
    for (const ref of [
      "https://evil.example/ops",
      "http://localhost:18080/ops",
      "//evil.example/ops",
      "/\\evil.example",
      "javascript:alert(1)",
      "ops",
      "",
      "   ",
      "/ops\nX-Evil: 1",
      "/ops /../../",
      "/a\tb",
    ]) {
      expect(appPathFromTargetRef(ref)).toBeNull();
    }
    expect(appPathFromTargetRef(null)).toBeNull();
    expect(appPathFromTargetRef(undefined)).toBeNull();
    expect(appPathFromTargetRef(42 as unknown as string)).toBeNull();
  });
});

describe("navigateTargetOf", () => {
  function nav(id: string, target: string): LocalMessage {
    const row = mapAssistantMessage(
      wireRow("change", {
        kind: "change",
        change_id: id,
        change_kind: "navigate",
        target_ref: target,
        summary: `Navigated to ${target}`,
        undoable: false,
      }),
    );
    if (row === null) throw new Error(`the navigate row for ${id} would not render`);
    return row;
  }
  function user(): LocalMessage {
    const row = mapAssistantMessage(wireRow("user", { kind: "user", text: "hi" }));
    if (row === null) throw new Error("the user row would not render");
    return row;
  }

  it("names nothing for a turn that did not navigate", () => {
    expect(navigateTargetOf([user()])).toBeNull();
    expect(navigateTargetOf([])).toBeNull();
  });

  it("skips every OTHER change kind — only `navigate` moves the client", () => {
    const mapped = mapAssistantMessage(
      wireRow("change", {
        kind: "change",
        change_id: "c-1",
        change_kind: "draft_edit",
        target_ref: "draft:d-1",
        summary: "Edited draft",
        undoable: true,
      }),
    );
    if (mapped === null) throw new Error("the draft_edit row would not render");
    expect(navigateTargetOf([mapped])).toBeNull();
  });

  it("takes the first performable navigation and still reports every change id", () => {
    const target = navigateTargetOf([user(), nav("c-1", "/ops"), nav("c-2", "/workflows")]);
    expect(target?.target).toBe("/ops");
    expect(target?.changeId).toBe("c-1");
    expect(target?.changeIds).toEqual(["c-1", "c-2"]);
  });

  it("passes over a target the client will not perform", () => {
    const target = navigateTargetOf([nav("c-1", "https://evil.example/ops"), nav("c-2", "/ops")]);
    expect(target?.target).toBe("/ops");
    // BOTH ids are reported, so the refused one can never navigate on a re-read.
    expect(target?.changeIds).toEqual(["c-1", "c-2"]);
  });
});
