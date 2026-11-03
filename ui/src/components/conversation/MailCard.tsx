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
import { MarkdownBody } from "../../lib/markdown";
import { STATES } from "../ds/states";
import type { EventEnvelope } from "../../api/types";
import type { StateName } from "../ds/states";

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
  /**
   * Set when a PERSON asked (ADR-0072 § 9: the frame carries no `turn_id`
   * and its actor is the controller who typed `@<repo> <question>`). The
   * transcript then shows the ask as that person's own message above this
   * card (rcn-3d review item 3) and the card does not repeat the sentence.
   */
  askedByUserId?: string;
}

/**
 * The link's state in the words and glyph the app already uses for it — the
 * same table the rail's LINKED CHATS rows read (`ConversationSidePanel`'
 * `mailLinkState`). It lives here too because the CARD answers the same
 * question, and it answers it from the mail frames and nothing else:
 * `conversation.mail.asked` opens the card, `conversation.mail.answered`
 * closes it. The thread's own turn is a different fact — the reviewer read
 * the chat header's "queued — waiting for a worker" (which describes the
 * follow-up turn the answer queues, `pages/Conversation.tsx`'s `turn-status`)
 * as the card still waiting, because the card itself never said it had
 * landed. An expired ask is the honest "we stopped waiting", so it takes the
 * interrupted glyph, not the failed one.
 */
export function mailCardState(state?: MailCardData["state"]): { name: StateName; word: string } {
  switch (state) {
    case "answered":
      return { name: "done", word: "answered" };
    case "failed":
      return { name: "failed", word: "failed" };
    case "expired":
      return { name: "interrupted", word: "expired" };
    default:
      return { name: "running", word: "asked" };
  }
}

/**
 * What a read-only mail answer means to the person reading it: the asked repo's
 * agent cannot edit that repo. No ADR reference, no wire enum.
 *
 * This is the sentence the ANSWERING thread's transcript prints as its muted
 * system line (a `conversation.notice` of kind `mail_readonly` names no
 * repository, so the thread's own row supplies it — `plainNoticeLines`). It was
 * once the card's own line, reached by cutting the worker's `workspace: `
 * paragraph out of the answer text; the note has its own journal row now, so
 * the card never carries it and the answer is printed whole.
 */
export function mailReadOnlyCopy(repo: string): string {
  return `Read-only: this agent can't change ${repo}.`;
}

/** Read an ask off its `conversation.mail.asked` envelope; null for a
 * rejected ask (see the header: rejections are not cards). */
export function mailAskedFromEvent(event: EventEnvelope): MailCardData | null {
  const payload = event.payload;
  if (!payload) return null;
  if (str(payload, "state") !== "asked") return null;
  const linkId = str(payload, "link_id");
  if (!linkId) return null;
  const turnId = str(payload, "turn_id");
  // ADR-0072 § 9: `turn_id` is empty when no agent turn asked — a person did,
  // from the composer, and the frame's actor is that person. The transcript
  // shows their `@<repo> <question>` as their own message (rcn-3d review
  // item 3); an agent-dispatched ask (§ 3) carries its turn and is NOT a
  // person's message.
  const askedByUserId = turnId === "" && event.actor?.kind === "human" ? event.actor.id : undefined;
  return {
    linkId,
    repo: str(payload, "repo"),
    question: str(payload, "question"),
    turnId,
    askedByUserId,
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
 * bare "← api" while the target went unnamed (a failed target whose row
 * names nothing prints no ghost segment).
 *
 * `agentLabel` is the caller's answer to "which agent answered" — the
 * profile's DISPLAY name and pinned model (`Claude Code · opus`), which is
 * what a person chose and what rcn-3d review item 4 asked for. It is absent
 * when no read names the launcher, and the line then wears the launcher id
 * the journal carried: the machine's word, honestly labelled, rather than a
 * guessed product name.
 */
export function mailAnswerLine(card: MailCardData, agentLabel?: string | null): string {
  const parts = ["\u2190 " + card.repo];
  if (agentLabel) parts.push(agentLabel);
  else if (card.launcher) parts.push(card.launcher);
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
  /**
   * The answering agent as a person knows it — `agentLabel(name, model)`
   * ("Claude Code · opus"). The host resolves it from the conversation's own
   * profile row (ADR-0072 § 10: a mailed chat inherits the asking chat's
   * profile) or from the org's profile list, and passes nothing when no read
   * names the answered card's `launcher_id`.
   */
  agentLabel?: string | null;
}

/** 3d's bordered mail card. */
export function MailCard({ card, testId = "mail-card", agentLabel }: MailCardProps) {
  const state = mailCardState(card.state);
  const spec = STATES[state.name];
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
        {/* Glyph AND word, from the mail frames only (`mailCardState`): the
            card says for itself whether the answer has landed, so the chat
            header's own turn line — which describes the follow-up turn the
            answer queues, and may well read `queued` a few seconds longer —
            is not mistaken for the mail's state (rcn-3d review item 2). */}
        <span className={`shrink-0 ${spec.tagFg}`} data-testid={`${testId}-state`}>
          <span aria-hidden="true">{spec.glyph}</span> {state.word}
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
      {/* A person's `@<repo> <question>` ask is THEIR message, and the
       * transcript prints it as one above this card (rcn-3d review item 3) —
       * the card then carries the answer, not the sentence a second time. An
       * agent-dispatched ask (§ 3) has no user message of its own, so its
       * card keeps the quote. */}
      {card.askedByUserId ? null : (
        <p
          className="border-b border-line-soft px-[10px] py-2 text-[12.5px] text-ink-2"
          data-testid={`${testId}-question`}
        >
          &ldquo;{card.question}&rdquo;
        </p>
      )}
      {card.state ? (
        <div className="flex flex-col gap-[3px] px-[10px] py-2" data-testid={`${testId}-answer`}>
          <span
            className="font-mono text-[10.5px] text-muted"
            data-testid={`${testId}-answer-line`}
            // The launcher id the journal actually carried stays reachable:
            // the label is the profile's display name, and the two can differ.
            title={card.launcher ? `launcher_id ${card.launcher}` : undefined}
          >
            {mailAnswerLine(card, agentLabel)}
          </span>
          {card.state === "answered" ? (
            // The answer is the other repo's agent's own markdown (rcn-3d
            // review item 4): printed raw it arrived with its backticks
            // (`README`), which is markup the reader has to parse instead of
            // a sentence. `MarkdownBody` is the app's own reader — React text
            // nodes, never HTML (ADR-0020) — so an answer that carries
            // formatting reads as formatting and one that does not reads
            // exactly as it did. It is the agent's whole answer: the worker's
            // system note is its own journal row now
            // (`conversation.notice`), never a paragraph to cut out.
            <MarkdownBody
              text={card.answer ?? ""}
              paragraphClassName="m-0 text-[12.5px] leading-[1.45] text-ink-2"
            />
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
          {/* The bar above already pairs the glyph with the state word
              (`● asked`), so this line adds only what the state cannot say:
              where the answer will appear. */}
          the answer arrives in this chat
        </p>
      )}
    </li>
  );
}
