/**
 * The transcript card for agent mail (ADR-0072, design 3d).
 *
 * The journal rows *are* the card: `conversation.mail.asked` (state
 * `asked`) opens it — a fill-coloured bar "→ asked the agent in <repo>"
 * with `open chat ›`, then the question; `conversation.mail.answered`
 * closes it — "← <repo> · <agent>" carrying the answer (or the failure
 * reason). Nothing is inferred:
 *
 * - the model segment the design draws ("Codex · gpt-5") is NOT rendered,
 *   because no journal row names a model (ADR-0068's honesty rule) — the
 *   agent segment is the target profile's `launcher_id`, which the answered
 *   row does carry;
 * - the design's tool-activity tail ("read handlers/search.go") is not
 *   rendered either: the answered row carries the answer text, not the
 *   linked chat's tool calls — those live in the linked chat's own
 *   transcript, one click away through `open chat ›`;
 * - `state: "rejected"` asks render nothing here: the ask never became a
 *   link, and the asking agent learns the reason through its own follow-up
 *   turn, so a card would advertise a link that does not exist.
 */
import { Link } from "react-router";
import { routes } from "../../lib/routes";
import type { EventEnvelope } from "../../api/types";

export interface MailCardData {
  linkId: string;
  repo: string;
  question: string;
  /** The asking chat's turn that dispatched the ask. */
  turnId: string;
  /** Set once `conversation.mail.answered` arrived. */
  state?: "answered" | "failed" | "expired";
  answer?: string;
  reason?: string;
  /** The target profile's launcher — the card's "← api · Codex" half. */
  launcher?: string;
  /** The linked chat `open chat ›` navigates to. */
  toConversationId?: string;
}

/** Read an ask off its `conversation.mail.asked` envelope; null for a
 * rejected ask (see the header: rejections are not cards). */
export function mailAskedFromEvent(event: EventEnvelope): MailCardData | null {
  const payload = event.payload;
  if (!payload) return null;
  if (str(payload, "state") !== "asked") return null;
  const linkId = str(payload, "link_id");
  if (!linkId) return null;
  return {
    linkId,
    repo: str(payload, "repo"),
    question: str(payload, "question"),
    turnId: str(payload, "turn_id"),
    toConversationId: str(payload, "to_conversation_id") || undefined,
  };
}

/** Fold a `conversation.mail.answered` envelope into its card, matched by
 * link id. Frames at or below the ask's own position are the replay guard's
 * business, not this function's: it merges by id and nothing else. */
export function mergeMailAnswered(card: MailCardData, event: EventEnvelope): MailCardData {
  const payload = event.payload;
  if (!payload || str(payload, "link_id") !== card.linkId) return card;
  const state = str(payload, "state");
  if (state !== "answered" && state !== "failed" && state !== "expired") return card;
  return {
    ...card,
    state,
    answer: str(payload, "answer") || undefined,
    reason: str(payload, "reason") || undefined,
    launcher: str(payload, "launcher_id") || undefined,
    toConversationId: str(payload, "to_conversation_id") || undefined,
  };
}

/** The card's answer line: "← api · Codex" plus the failure word, or the
 * bare "← api" while the launcher went unreported (a failed target whose
 * row names nothing prints no ghost segment). */
export function mailAnswerLine(card: MailCardData): string {
  const parts = ["\u2190 " + card.repo];
  if (card.launcher) parts.push(card.launcher);
  if (card.state && card.state !== "answered") parts.push(card.state);
  return parts.join(" \u00b7 ");
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

export interface MailCardProps {
  card: MailCardData;
  testId?: string;
}

/** 3d's bordered mail card. */
export function MailCard({ card, testId = "mail-card" }: MailCardProps) {
  return (
    <li
      data-testid={testId}
      data-link-id={card.linkId}
      className="overflow-hidden rounded-[3px] border border-line-strong bg-surface"
    >
      <div
        className="flex items-center gap-2 border-b border-line-strong bg-fill px-[10px] py-1.5 font-mono text-[10.5px] text-ink-2"
        data-testid={`${testId}-bar`}
      >
        <span>
          {"\u2192"} asked the agent in <b className="font-semibold text-ink">{card.repo}</b>
        </span>
        {card.toConversationId ? (
          <Link
            to={routes.thread(card.toConversationId)}
            className="ml-auto shrink-0 text-accent-text hover:text-ink"
            data-testid={`${testId}-open-chat`}
          >
            {"open chat \u203a"}
          </Link>
        ) : null}
      </div>
      <p
        className="border-b border-line-soft px-[10px] py-2 text-[12.5px] text-ink-2"
        data-testid={`${testId}-question`}
      >
        &ldquo;{card.question}&rdquo;
      </p>
      {card.state ? (
        <div className="flex flex-col gap-[3px] px-[10px] py-2" data-testid={`${testId}-answer`}>
          <span className="font-mono text-[10.5px] text-muted">{mailAnswerLine(card)}</span>
          {card.state === "answered" ? (
            <span className="whitespace-pre-wrap text-[12.5px] text-ink-2">{card.answer}</span>
          ) : (
            <span className="text-[12.5px] text-ink-2" data-testid={`${testId}-reason`}>
              {card.reason ?? "no answer arrived."}
            </span>
          )}
        </div>
      ) : (
        <p
          className="px-[10px] py-2 font-mono text-[10.5px] text-muted"
          data-testid={`${testId}-pending`}
          role="status"
        >
          <span aria-hidden="true" className="text-st-running-strong">
            {"\u25cf "}
          </span>
          asked · the answer arrives in this chat
        </p>
      )}
    </li>
  );
}
