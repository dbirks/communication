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
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Transcript from "./Transcript";
import { projectTranscript } from "../api/transcript";
import { conversationEvent, turnFixture, turnId } from "../test/fakes";
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
