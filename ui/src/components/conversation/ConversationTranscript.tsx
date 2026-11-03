/**
 * The conversation transcript with ADR-0068's agent-switch dividers.
 *
 * `Transcript` renders one flat list and cannot be touched from this task's
 * boundaries, so this wrapper composes it: the items are cut at every
 * `conversation.agent.switched` journal frame (ordered by `global_seq`, the
 * same cursor the fold itself dedupes on) and each run of items renders as
 * its own `Transcript`, with the divider between them. A conversation that
 * never switched agents renders exactly one `Transcript`, as before.
 *
 * The agent label per run answers the design's `Agent · model` header:
 *
 * - No switch ever happened, so every turn ran on the conversation's current
 *   profile: the label is `agent_profile_name · agent_profile_model` (the
 *   model segment only when the profile pins one — ADR-0068: null is the
 *   honest "names no model").
 * - After a switch, each following run takes its label from the switch row's
 *   `to_profile_name`/`model`; the first run takes the profile from the
 *   derived `agents` list (the entry whose range starts at turn 1) or from
 *   the `conversation.created` frame. When neither is in the retained stream
 *   the label falls back to a plain "agent" — never the *current* profile,
 *   which after a switch would misname every earlier turn.
 * - `· skill: name` (design 2e) is not rendered because no wire data carries
 *   a per-message skill today; the day the journal names one, this is the
 *   place it lands.
 */
import Transcript from "../Transcript";
import { useAgentProfiles } from "../../api/queries";
import type { TranscriptItem } from "../../api/transcript";
import type { EventEnvelope } from "../../api/types";
import { agentDisplayForLauncher, launcherNameSource } from "./agentNames";
import { AgentSwitchDivider, agentSwitchFromEvent } from "./AgentSwitchDivider";
import { MailCard, mailAskedFromEvent, mergeMailAnswered, type MailCardData } from "./MailCard";
import { renderSplitAtTurnFailures } from "./TurnFailureNotice";
import type { ConversationSession } from "./useConversationSession";

/** `Codex · gpt-5`, or just `Codex` when the profile names no model. */
export function agentLabel(name: string, model?: string | null): string {
  return model ? `${name} · ${model}` : name;
}

/**
 * The mail card's answering agent, in the words a person chose (rcn-3d review
 * item 4). The answered row carries the target profile's `launcher_id`, and the
 * card used to print it (`← server · claude`) — the executable, not the
 * agent.
 *
 * ADR-0072 § 10 is the read that names it: a mailed chat INHERITS the asking
 * chat's current profile, so a card whose launcher is this conversation's own
 * launcher is answered by the profile row on this very read. Any other launcher
 * goes through the same resolver the transcript uses, and an unrecognised one
 * yields null — the card then prints the launcher id it was given rather than
 * guessing a product name.
 */
export function mailAgentLabel(
  launcher: string | undefined,
  data:
    | {
        launcher_id?: string | null;
        agent_profile_name?: string | null;
        agent_profile_model?: string | null;
      }
    | undefined,
  events: readonly EventEnvelope[],
  profiles: readonly { launcher_id: string; name: string; model?: string | null }[],
): string | null {
  if (!launcher) return null;
  const display = agentDisplayForLauncher(launcher, launcherNameSource(data, events, profiles));
  return display ? agentLabel(display.name, display.model) : null;
}

/**
 * Cut the folded items at every `conversation.agent.switched` frame.
 * Exported for tests: it is the whole behaviour of this surface, and it runs
 * on plain data.
 */
export function splitAtAgentSwitches(
  items: readonly TranscriptItem[],
  events: readonly EventEnvelope[],
): { divider: EventEnvelope | null; items: TranscriptItem[] }[] {
  const seqById = new Map<string, number>();
  const switches: EventEnvelope[] = [];
  const seen = new Set<number>();
  for (const event of events) {
    // The same replay guard the fold applies: one `global_seq` folds once.
    if (seen.has(event.global_seq)) continue;
    seen.add(event.global_seq);
    seqById.set(event.event_id, event.global_seq);
    if (event.type === "conversation.agent.switched") switches.push(event);
  }
  const parts: { divider: EventEnvelope | null; items: TranscriptItem[] }[] = [
    { divider: null, items: [] },
  ];
  let next = 0;
  for (const item of items) {
    const itemSeq = seqById.get(item.id);
    if (itemSeq !== undefined) {
      // A switch belongs before the first frame that committed after it. An
      // item whose originating frame is not in the window (impossible from
      // this page's own stream, defensive for reuse elsewhere) keeps its
      // position and does not flush pending dividers.
      while (
        next < switches.length &&
        (seqById.get(switches[next].event_id) ?? Number.POSITIVE_INFINITY) < itemSeq
      ) {
        parts.push({ divider: switches[next], items: [] });
        next += 1;
      }
    }
    parts[parts.length - 1].items.push(item);
  }
  while (next < switches.length) {
    parts.push({ divider: switches[next], items: [] });
    next += 1;
  }
  return parts;
}

export interface ConversationTranscriptProps {
  session: ConversationSession;
}

/**
 * One render part: an optional agent-switch divider, the agent-mail cards
 * opened at this point (ADR-0072), then the transcript items that follow.
 * A mail card cuts the stream at its `conversation.mail.asked` frame — the
 * worker dispatches after the final transcript flush, so the card lands
 * directly under the answer that asked. `conversation.mail.answered` does
 * not cut anything: it merges into the open card by link id, wherever in
 * the window it sits.
 */
export interface TranscriptSegment {
  divider: EventEnvelope | null;
  mails: MailCardData[];
  items: TranscriptItem[];
}

/** Cut the folded items at every agent-switch AND accepted-mail frame.
 * Exported for tests (same reason as splitAtAgentSwitches, which stays for
 * its own contract). */
export function segmentTranscript(
  items: readonly TranscriptItem[],
  events: readonly EventEnvelope[],
): TranscriptSegment[] {
  const seqById = new Map<string, number>();
  const seen = new Set<number>();
  const frames: EventEnvelope[] = [];
  for (const event of events) {
    if (seen.has(event.global_seq)) continue;
    seen.add(event.global_seq);
    seqById.set(event.event_id, event.global_seq);
    if (event.type === "conversation.agent.switched") {
      frames.push(event);
    } else if (event.type === "conversation.mail.asked" && mailAskedFromEvent(event)) {
      // Only an accepted ask cuts the transcript; a rejected one is a
      // journal row and a follow-up notice, never a card.
      frames.push(event);
    }
  }
  const parts: TranscriptSegment[] = [{ divider: null, mails: [], items: [] }];
  /** Open the part one cut frame starts. A person's @-ask also closes the
   * part BEFORE it: the composer's `@<repo> <question>` is that person's own
   * message (ADR-0072 § 9 journals no turn and no user frame for it, which is
   * why the reviewed card floated above no message at all), so the transcript
   * prints it as theirs, directly over the card that answers it. The card
   * then carries the answer instead of quoting the same sentence twice. */
  const cut = (frame: EventEnvelope) => {
    if (frame.type === "conversation.agent.switched") {
      parts.push({ divider: frame, mails: [], items: [] });
      return;
    }
    const card = mailAskedFromEvent(frame);
    if (!card) return;
    if (card.askedByUserId) {
      parts[parts.length - 1].items.push({
        kind: "user",
        id: `mail-ask-${card.linkId}`,
        turnId: "",
        authorUserId: card.askedByUserId,
        text: `@${card.repo} ${card.question}`,
        at: frame.occurred_at,
      });
    }
    parts.push({ divider: null, mails: [card], items: [] });
  };
  let next = 0;
  for (const item of items) {
    const itemSeq = seqById.get(item.id);
    if (itemSeq !== undefined) {
      while (
        next < frames.length &&
        (seqById.get(frames[next].event_id) ?? Number.POSITIVE_INFINITY) < itemSeq
      ) {
        cut(frames[next]);
        next += 1;
      }
    }
    parts[parts.length - 1].items.push(item);
  }
  while (next < frames.length) {
    cut(frames[next]);
    next += 1;
  }
  // Fold every answered row into its card, then render. Answered rows need
  // no position: the card belongs at the ask.
  const answered = events.filter((event) => event.type === "conversation.mail.answered");
  for (const part of parts) {
    for (let i = 0; i < part.mails.length; i += 1) {
      for (const event of answered) {
        part.mails[i] = mergeMailAnswered(part.mails[i], event);
      }
    }
  }
  return parts;
}

/** The session's transcript, with a divider where the agent was switched
 * and a mail card where an ask landed (ADR-0072). */
export function ConversationTranscript({ session }: ConversationTranscriptProps) {
  const { data, transcript, events, isController, nameOf } = session;
  const parts = segmentTranscript(transcript.items, events);
  const switched = parts.some((part) => part.divider !== null);
  // The same cached profiles read the composer chip and the session fold make
  // (`queryKeys.agentProfiles`) — the third arm of naming a launcher, used
  // only when the conversation row and its switch dividers do not answer.
  const agentProfiles = useAgentProfiles();

  /**
   * The agent a `launcher_id` names, in the words the person chose — the read
   * the failed-turn notice asks for when the worker says
   * `launcher "codex" is not signed in` (rcn-2f review item 3): the sentence
   * names the agent ("Codex isn't signed in on this worker…"), and only a
   * launcher no read names falls back to the executable it was given. The same
   * resolver the mail cards use: one conversation read, one answer.
   */
  const nameSource = launcherNameSource(data, events, agentProfiles.data?.items ?? []);
  const agentNameForLauncher = (launcherId: string) =>
    agentDisplayForLauncher(launcherId, nameSource)?.name ?? null;

  // The label for the run before any switch.
  let initial = "agent";
  if (!switched) {
    initial = agentLabel(data?.agent_profile_name ?? "agent", data?.agent_profile_model);
  } else {
    const first = (data?.agents ?? []).find((entry) => entry.first_turn === 1);
    const created = events.find((event) => event.type === "conversation.created");
    const createdName =
      typeof created?.payload?.agent_profile_name === "string"
        ? created.payload.agent_profile_name
        : "";
    initial = first ? agentLabel(first.agent_profile_name, first.model) : createdName || "agent";
  }

  const controllerName = data
    ? (data.control.display_name ??
      (data.control.user_id ? session.nameOf(data.control.user_id) : null))
    : null;

  const transcriptFor = (items: TranscriptItem[], agentName: string) => (
    <Transcript
      items={items}
      agentName={agentName}
      canDecide={isController}
      controllerName={controllerName}
      nameOf={nameOf}
      onDecide={session.onDecide}
      decidingRequestId={session.decidingRequestId}
      decisionError={session.decide.error}
      decisionErrorRequestId={
        session.decide.isError ? (session.decide.variables?.requestId ?? null) : null
      }
    />
  );

  /**
   * One run's items, with a failed turn cut out of the list and printed as
   * `TurnFailureNotice` in its place (error-details-r6): the fold's own
   * `Turn failed: worker: prepare workspace for project 01a19c73-…` line is
   * developer text, and the reader gets one plain sentence with the server's
   * words behind `Details` instead. A run with no failure renders exactly one
   * `Transcript`, as before.
   */
  const runFor = (items: TranscriptItem[], agentName: string, keyBase: string) =>
    renderSplitAtTurnFailures(
      items,
      events,
      keyBase,
      (list) => transcriptFor(list, agentName),
      agentNameForLauncher,
    );

  return (
    <>
      {parts.map((part, index) => {
        const label = part.divider
          ? agentLabel(
              String(part.divider.payload?.to_profile_name ?? "agent"),
              typeof part.divider.payload?.model === "string" ? part.divider.payload.model : null,
            )
          : initial;
        return (
          <div
            key={
              part.divider ? part.divider.event_id : (part.mails[0]?.linkId ?? `segment-${index}`)
            }
            className="space-y-[4px]"
          >
            {part.divider ? (
              <AgentSwitchDivider {...agentSwitchFromEvent(part.divider, nameOf)} />
            ) : null}
            {part.mails.length > 0 ? (
              <ul className="list-none space-y-[4px]" data-testid="transcript-mail-cards">
                {part.mails.map((card) => (
                  <MailCard
                    key={card.linkId}
                    card={card}
                    agentLabel={mailAgentLabel(
                      card.launcher,
                      data,
                      events,
                      agentProfiles.data?.items ?? [],
                    )}
                  />
                ))}
              </ul>
            ) : null}
            {part.items.length > 0 || parts.length === 1
              ? runFor(part.items, label, `segment-${index}`)
              : null}
          </div>
        );
      })}
    </>
  );
}
