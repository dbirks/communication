/**
 * What the transcript says about who put a prompt in the queue (ADR-0062).
 *
 * `conversation.message.user` carries `submitted_by`, and since migration 00017
 * that id is not always a person who typed: for an automation turn it is the
 * member who authorised the automation. The turn row's `submitted_via` is the
 * only thing that tells the two apart, so the rendering rule under test is
 * narrow — an automation says so in words, a human (or a turn nobody qualified)
 * reads exactly as it always did.
 *
 * Items are built by `projectTranscript` from wire-shaped frames plus
 * `ConversationTurn` rows rather than hand-written, so a fixture cannot claim a
 * field the API does not send.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Transcript, { permissionWindowLabel } from "./Transcript";
import { projectTranscript } from "../api/transcript";
import { conversationEvent, turnFixture, turnId } from "../test/fakes";
import type { TranscriptItem } from "../api/transcript";
import { nameLookup, resolveName } from "../api/names";
import type { ConversationTurn, EventEnvelope } from "../api/types";

afterEach(cleanup);

const authorId = "01987a62-2345-7000-8000-abcdef012345";
const lookup = nameLookup([[authorId, "Ada Lovelace"]]);
const nameOf = (userId: string) => resolveName(userId, lookup);

/** One prompt's frames, as the stream would deliver them. */
function frames(): EventEnvelope[] {
  return [
    conversationEvent(
      "conversation.message.user",
      { turn_id: turnId, submitted_by: authorId, text: "Tidy the flaky spec" },
      { global_seq: 1 },
    ),
    conversationEvent(
      "conversation.message.agent",
      { turn_id: turnId, text: "On it.", final: true },
      { global_seq: 2 },
    ),
  ];
}

function renderTurn(turnRows: ConversationTurn[]) {
  const items = projectTranscript(frames(), nameOf, turnRows).items;
  render(
    <Transcript
      items={items}
      canDecide={false}
      controllerName={null}
      nameOf={nameOf}
      onDecide={() => {}}
      decidingRequestId={null}
      decisionError={null}
      decisionErrorRequestId={null}
    />,
  );
  return items;
}

describe("Transcript turn submitter (ADR-0062)", () => {
  it("names the author plainly when the turn row says a human submitted it", () => {
    renderTurn([turnFixture({ id: turnId, submitted_by: authorId, submitted_via: "human" })]);
    expect(screen.getByText("Tidy the flaky spec")).toBeTruthy();
    expect(screen.queryByTestId("turn-on-behalf-of")).toBeNull();
    // Today's rendering: the bold author prefix, unchanged.
    const bubble = screen.getByText("Tidy the flaky spec").closest("li");
    expect(bubble?.textContent).toContain("Ada Lovelace:");
  });

  it("names the author plainly when the control plane sent no submitted_via at all", () => {
    // A pre-ADR-0062 producer omits the optional field; that is an unknown
    // origin, and the honest answer is the rendering the app has always had.
    const row = turnFixture({ id: turnId, submitted_by: authorId });
    delete row.submitted_via;
    renderTurn([row]);
    const bubble = screen.getByText("Tidy the flaky spec").closest("li");
    expect(bubble?.textContent).toContain("Ada Lovelace:");
    expect(screen.queryByTestId("turn-on-behalf-of")).toBeNull();
  });

  it("says on behalf of whom an issue trigger's turn ran, instead of crediting an author", () => {
    renderTurn([
      turnFixture({ id: turnId, submitted_by: authorId, submitted_via: "issue_trigger" }),
    ]);
    const line = screen.getByTestId("turn-on-behalf-of");
    expect(line.textContent).toBe("on behalf of Ada Lovelace · issue trigger");
    // The plain-author prefix is gone: this prompt was not typed by a person.
    const bubble = screen.getByText("Tidy the flaky spec").closest("li");
    expect(bubble?.textContent).not.toContain("Ada Lovelace:");
    // The meta-line style the surrounding lines wear: mono, 11px, muted.
    expect(line.className).toContain("font-mono");
    expect(line.className).toContain("text-[11px]");
    expect(line.className).toContain("text-muted");
  });

  it("says a schedule fired the turn", () => {
    renderTurn([turnFixture({ id: turnId, submitted_by: authorId, submitted_via: "schedule" })]);
    expect(screen.getByTestId("turn-on-behalf-of").textContent).toBe(
      "on behalf of Ada Lovelace · schedule",
    );
  });

  it("says a pipeline.invoke child inherited the turn", () => {
    renderTurn([turnFixture({ id: turnId, submitted_by: authorId, submitted_via: "child_run" })]);
    expect(screen.getByTestId("turn-on-behalf-of").textContent).toBe(
      "on behalf of Ada Lovelace · child run",
    );
  });

  it("keeps today's rendering for a prompt no turn row explains", () => {
    const items = renderTurn([]);
    expect(items[0]?.kind).toBe("user");
    expect(screen.queryByTestId("turn-on-behalf-of")).toBeNull();
    expect(screen.getByText("Tidy the flaky spec").closest("li")?.textContent).toContain(
      "Ada Lovelace:",
    );
  });
});

describe("agent replies read as markdown (rcn-3d round 14)", () => {
  /** The reply the reviewed chat printed raw: markers as characters. */
  const reply =
    'I updated the `server` repository agent.\n\n- The `server` repo owns the `README` file\n\n**"Hello World!"**';

  function renderAgentReply(frames: EventEnvelope[]) {
    const items = projectTranscript(frames, nameOf).items;
    render(
      <Transcript
        items={items}
        agentName="m4-implementer"
        canDecide={false}
        controllerName={null}
        nameOf={nameOf}
        onDecide={() => {}}
        decidingRequestId={null}
        decisionError={null}
        decisionErrorRequestId={null}
      />,
    );
    return items;
  }

  it("renders code spans, a bullet list and strong in an agent reply, markers read not printed", () => {
    renderAgentReply([
      conversationEvent("conversation.message.agent", {
        turn_id: turnId,
        text: reply,
        final: true,
      }),
    ]);
    const row = screen.getByTestId("transcript-item") as HTMLElement;
    const codes = Array.from(row.querySelectorAll("code")).map((el) => el.textContent);
    expect(codes).toContain("server");
    expect(codes).toContain("README");
    const list = within(row).getByTestId("markdown-list");
    expect(list.tagName).toBe("UL");
    const listItems = within(row).getAllByTestId("markdown-list-item");
    expect(listItems).toHaveLength(1);
    expect(listItems[0].textContent).toContain("The");
    const strong = within(row).getByRole("strong");
    expect(strong.textContent).toBe('"Hello World!"');
    // The markers are read, never printed:
    expect(row.textContent).not.toContain("**");
    expect(row.textContent).not.toContain("- The");
    expect(row.textContent).not.toContain("`server`");
    expect(list).toBeTruthy();
  });

  it("keeps a user prompt literal with the same markup: no code, list or strong", () => {
    renderAgentReply([
      conversationEvent("conversation.message.user", {
        turn_id: turnId,
        submitted_by: authorId,
        text: reply,
      }),
    ]);
    const bubble = screen.getByTestId("transcript-item") as HTMLElement;
    expect(bubble.textContent).toContain(reply);
    expect(bubble.textContent).toContain("`server`");
    expect(bubble.textContent).toContain('**"Hello World!"**');
    expect(bubble.querySelector("code")).toBeNull();
    expect(bubble.querySelector("ul, ol")).toBeNull();
    expect(bubble.querySelector("strong, em")).toBeNull();
  });

  it("reads a reply streamed in two chunks as one markdown block over the joined text", () => {
    const first = "Fixes for `server`:\n";
    const second = "- first fix\n- second fix";
    const items = renderAgentReply([
      conversationEvent("conversation.message.agent", {
        turn_id: turnId,
        text: first,
        final: false,
      }),
      conversationEvent("conversation.message.agent", {
        turn_id: turnId,
        text: second,
        final: true,
      }),
    ]);
    // The fold joins the chunks: one agent row, one block, markers already spent.
    expect(items).toHaveLength(1);
    const row = screen.getByTestId("transcript-item");
    expect(within(row).getAllByTestId("markdown-body")).toHaveLength(1);
    const list = within(row).getByTestId("markdown-list");
    expect(list.tagName).toBe("UL");
    expect(within(list).getAllByTestId("markdown-list-item")).toHaveLength(2);
    expect(within(row).getAllByTestId("markdown-list-item")[1].textContent).toContain("second fix");
    const codes = Array.from(row.querySelectorAll("code")).map((el) => el.textContent);
    expect(codes).toContain("server");
    expect(row.textContent).not.toContain("first fix\\n");
  });
});

describe("an agent message with no words draws nothing (deployed finding 2026-11-11)", () => {
  function renderItems(events: EventEnvelope[]) {
    const items = projectTranscript(events, nameOf).items;
    render(
      <Transcript
        items={items}
        agentName="Pi"
        canDecide={false}
        controllerName={null}
        nameOf={nameOf}
        onDecide={() => {}}
        decidingRequestId={null}
        decisionError={null}
        decisionErrorRequestId={null}
      />,
    );
    return items;
  }

  it("draws no speaker block for a whitespace-only agent message", () => {
    // The deployed thread: pi's chunks while the model retried were only
    // "\n\n", and the page printed an empty "Pi · 06:45:07 UTC" header — a
    // block that said nothing, in an aria-live list that announced it.
    const items = renderItems([
      conversationEvent(
        "conversation.message.user",
        { submitted_by: authorId, text: "Summarize the README" },
        { global_seq: 1 },
      ),
      conversationEvent(
        "conversation.message.agent",
        { text: "\n\n", final: false },
        { global_seq: 2 },
      ),
    ]);
    // The fold still keeps the item: the "writing…" state and the
    // ended-without-an-answer line both read it. The view just draws nothing.
    expect(items.map((item) => item.kind)).toEqual(["user", "agent"]);
    expect(screen.getAllByTestId("transcript-item")).toHaveLength(1);
    expect(screen.queryByTestId("agent-speaker")).toBeNull();
    expect(screen.queryByText("writing…")).toBeNull();
    expect(screen.getByTestId("transcript").textContent).not.toContain("Pi ·");
  });

  it("draws the answer as soon as it has a word in it", () => {
    // The other half: this is an empty-block rule, not a rule about pi's
    // answers. Text that is not only whitespace renders as it always did.
    renderItems([
      conversationEvent(
        "conversation.message.agent",
        { text: "The README says: run pnpm test.", final: true },
        { global_seq: 3 },
      ),
    ]);
    const row = screen.getByTestId("transcript-item");
    expect(within(row).getByTestId("agent-speaker").textContent).toContain("Pi ·");
    expect(row.textContent).toContain("run pnpm test");
  });
});

/**
 * The expired prompt explains itself (docs/testing/claude-ask-mode-2026-11-11
 * proposal 3): a closed `status: expired` chip alone read as "the tool
 * failed", and the agent wrote it down against itself. The card now states
 * the rule — nobody answered inside the window the worker opened with, so
 * the agent was told no. The window is the row's own arithmetic
 * (`deadline_at − requested_at`), so the sentence names THIS deployment's
 * TTL without the UI ever reading worker config.
 */
describe("PermissionCard expired copy (ask-mode fix 3)", () => {
  const requestId = "01987a72-3333-7000-8000-abcdef987654";
  const permissionOptions = [
    { option_id: "allow-once", label: "Yes", kind: "allow_once" },
    { option_id: "reject", label: "No", kind: "reject_once" },
  ];

  function frames(deadlineAt?: string): EventEnvelope[] {
    return [
      conversationEvent(
        "conversation.permission.requested",
        {
          permission_request_id: requestId,
          title: "git ls-files",
          kind: "execute",
          options: permissionOptions,
          ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
        },
        { occurred_at: "2026-10-14T18:00:00Z" },
      ),
      conversationEvent(
        "conversation.permission.decided",
        { permission_request_id: requestId, status: "expired" },
        { occurred_at: "2026-10-14T18:10:01Z" },
      ),
    ];
  }

  function renderFrames(events: EventEnvelope[]) {
    const items = projectTranscript(events, nameOf).items;
    render(
      <Transcript
        items={items}
        canDecide={false}
        controllerName={null}
        nameOf={nameOf}
        onDecide={() => {}}
        decidingRequestId={null}
        decisionError={null}
        decisionErrorRequestId={null}
      />,
    );
    return items;
  }

  it("names the window it gave and what the lapse decided", () => {
    renderFrames(frames("2026-10-14T18:10:00Z"));
    expect(screen.getByTestId("permission-expired-copy").textContent).toBe(
      "Nobody answered within 10 minutes, so the agent was told no.",
    );
  });

  it("stays honest when the frames carry no deadline to measure", () => {
    renderFrames(frames());
    expect(screen.queryByTestId("permission-expired-copy")).toBeNull();
  });

  it("permissionWindowLabel reads the window in whole units, and only when both stamps exist", () => {
    const base: Extract<TranscriptItem, { kind: "permission" }> = {
      kind: "permission",
      id: "e1",
      turnId: turnId,
      requestId: "r1",
      title: "t",
      toolKind: "",
      options: [],
      status: "expired",
      decisionOptionId: null,
      decidedBy: null,
      deadlineAt: null,
    };
    expect(
      permissionWindowLabel({
        ...base,
        requestedAt: "2026-10-14T18:00:00Z",
        deadlineAt: "2026-10-14T18:00:30Z",
      }),
    ).toBe("30 seconds");
    expect(
      permissionWindowLabel({
        ...base,
        requestedAt: "2026-10-14T18:00:00Z",
        deadlineAt: "2026-10-14T19:00:00Z",
      }),
    ).toBe("1 hour");
    // Sub-second journal drift on a 2-minute window still says "2 minutes".
    expect(
      permissionWindowLabel({
        ...base,
        requestedAt: "2026-10-14T16:12:20.406Z",
        deadlineAt: "2026-10-14T16:14:20Z",
      }),
    ).toBe("2 minutes");
    expect(permissionWindowLabel({ ...base, requestedAt: "2026-10-14T18:00:00Z" })).toBeNull();
    expect(permissionWindowLabel({ ...base, deadlineAt: "2026-10-14T18:10:00Z" })).toBeNull();
    // A deadline before the request is not a window; it gets no sentence.
    expect(
      permissionWindowLabel({
        ...base,
        requestedAt: "2026-10-14T18:10:00Z",
        deadlineAt: "2026-10-14T18:00:00Z",
      }),
    ).toBeNull();
  });
});
