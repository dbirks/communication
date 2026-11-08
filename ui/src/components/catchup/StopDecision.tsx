/**
 * The decision a stop may carry (design 8b "Decisions inside the tour",
 * ADR-0078 § Decision 4): the model's prompt, 1–4 option labels, and an
 * optional free-text box when the model offered one. The choice posts as
 * plain text to the agent's conversation.
 *
 * This is deliberately NOT the workflow gate — a gate carries the fixed
 * decide verbs and moves a run state; this asks a question and answers
 * nothing. Do not reach for DecisionBar here.
 *
 * States: sending; sent ("Sent to the agent: “{text}”" + the clock); a busy
 * agent (the conversation's own 409) says the answer was not sent and offers
 * Retry; a work item with no conversation stores the answer but nobody
 * receives it, which is shown as the honest dead end it is.
 */
import { useState } from "react";
import { ApiError } from "../../api/client";
import { useReplyToStop, type CatchUpDecision } from "../../api/catchup";
import { Button } from "../ds/Button";
import { clockOf } from "./importance";

export interface StopDecisionProps {
  itemId: string;
  stopId: string;
  decision: CatchUpDecision;
}

export function StopDecision({ itemId, stopId, decision }: StopDecisionProps) {
  const reply = useReplyToStop();
  const [draft, setDraft] = useState("");
  const [attempted, setAttempted] = useState("");
  const [sentText, setSentText] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

  const options = decision.options.slice(0, 4);
  const sending = reply.isPending;
  const error = reply.error;
  const busy = error instanceof ApiError && error.status === 409;
  const result = reply.data;
  const delivered = result != null && result.conversation_id != null;
  const storedOnly = result != null && result.conversation_id == null;

  const send = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) return;
    setAttempted(trimmed);
    reply.mutate(
      { itemId, stopId, text: trimmed },
      {
        onSuccess: () => {
          setSentText(trimmed);
          setSentAt(replyClock());
        },
      },
    );
  };

  return (
    <section
      data-testid="catchup-decision"
      className="flex flex-col gap-[8px] rounded-panel border border-st-waiting-pale-edge bg-st-waiting-pale-body p-[10px]"
    >
      <p className="text-[13px] font-semibold text-ink">{decision.prompt}</p>
      <div className="flex flex-wrap items-center gap-[6px]">
        {options.map((option, index) => (
          <Button
            key={option}
            variant={sentText === option ? "primary" : "secondary"}
            disabled={sending || sentText !== null}
            data-testid={`catchup-decision-option-${index + 1}`}
            onClick={() => send(option)}
          >
            {option}
          </Button>
        ))}
      </div>
      {decision.allow_text ? (
        <form
          className="flex items-center gap-[6px]"
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <input
            type="text"
            value={draft}
            disabled={sending || sentText !== null}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write your own answer…"
            data-testid="catchup-decision-text"
            className="h-[28px] min-w-0 flex-1 rounded-panel border border-line-strong bg-surface px-[8px] font-ui text-[13px] text-ink placeholder:text-faint disabled:opacity-60"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={sending || sentText !== null || draft.trim().length === 0}
            data-testid="catchup-decision-send"
          >
            Send
          </Button>
        </form>
      ) : null}
      <div data-testid="catchup-decision-status" className="font-mono text-[11px] text-ink-2">
        {sending ? <span>Sending…</span> : null}
        {!sending && sentText !== null && delivered ? (
          <span className="text-st-done-tag-fg">
            Sent to the agent: “{sentText}”{sentAt ? ` · ${sentAt}` : ""}
          </span>
        ) : null}
        {!sending && sentText !== null && storedOnly ? (
          <span>
            Saved. This work has no agent session to answer, so nobody was notified.
            {sentAt ? ` · ${sentAt}` : ""}
          </span>
        ) : null}
        {!sending && busy ? (
          <span className="text-st-failed-pale-fg">
            The agent is busy right now. Your answer wasn't sent — try again in a moment.{" "}
            <button
              type="button"
              data-testid="catchup-decision-retry"
              className="font-semibold text-accent-text underline"
              onClick={() => send(sentText ?? attempted)}
            >
              Retry
            </button>
          </span>
        ) : null}
        {!sending && error != null && !busy && sentText === null ? (
          <span className="text-st-failed-pale-fg">
            Your answer wasn't sent — nothing was recorded.{" "}
            <button
              type="button"
              data-testid="catchup-decision-retry"
              className="font-semibold text-accent-text underline"
              onClick={() => send(sentText ?? attempted)}
            >
              Retry
            </button>
          </span>
        ) : null}
      </div>
    </section>
  );
}

/** Stamp the sent line carries — the clock of the moment the answer landed. */
export function replyClock(now: Date = new Date()): string {
  return clockOf(now.toISOString()) ?? "";
}
